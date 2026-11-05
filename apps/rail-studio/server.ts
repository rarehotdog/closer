// Closer (Google AI Studio version) server: serves the app and one route that sends a photo to
// Meta's models (server/scan.ts). The Meta key is read from the server environment only
// (MODEL_API_KEY, or META_API_KEY as set in AI Studio Settings -> Secrets). It never reaches the
// browser bundle, a log line or a response.
import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createRealTransport, type Transport } from './server/closer/adapters/transport.ts';
import { createFakeMetaTransport } from './server/fakeMeta.ts';
import { scanPhoto } from './server/scan.ts';
import { createAccountRouter, type AccountRouterOptions } from './server/accountRouter.ts';
import { accountDatabasePath, isPrivateFileRequest } from './server/privateFiles.ts';
import { ScanJournal } from './server/scanJournal.ts';

export type ScanMode = 'live' | 'fake' | 'no_key' | 'off';

const env = process.env;
const metaKey = () => (env.MODEL_API_KEY ?? '').trim() || (env.META_API_KEY ?? '').trim();

/** live with a key; the test fake only when asked for and no key is set; off with the kill switch. */
export function scanMode(): ScanMode {
  if (env.CLOSER_KILL === '1') return 'off';
  if (metaKey()) return 'live';
  if (env.CLOSER_SCAN_FAKE === '1') return 'fake';
  return 'no_key';
}

// Local cost estimates gate each attempt; reservations survive process restarts.
const scanBudget = () => Math.round(Math.min(50, Math.max(0, Number(env.CLOSER_SCAN_BUDGET_USD ?? 2) || 0)) * 1_000_000);

// Rate limit per address: 20 scans per 10 minutes.
const WINDOW_MS = 10 * 60 * 1000;
const hits = new Map<string, number[]>();
function limited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= 20) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

function transportFor(mode: ScanMode): Transport | null {
  if (mode === 'live') return createRealTransport({ ...env, MODEL_API_KEY: metaKey(), CLOSER_FORBID_REAL: undefined });
  if (mode === 'fake') return createFakeMetaTransport();
  return null;
}

export interface ScanRuntimeOptions {
  /** Dependency injection for local route tests. Production uses the real provider transport. */
  transportFor?: (mode: ScanMode) => Transport | null;
}
export function createApp(accountOptions?: AccountRouterOptions, scanOptions: ScanRuntimeOptions = {}) {
  const app = express();
  app.disable('x-powered-by');
  const databasePath = accountOptions?.dbPath ?? accountDatabasePath();
  app.use((req, res, next) => {
    if (isPrivateFileRequest(req.originalUrl, databasePath)) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(404).end();
      return;
    }
    next();
  });

  // Databases are lazy: mode/status checks and public samples do not create account data.
  let accountRoutes: ReturnType<typeof createAccountRouter> | undefined;
  let journal: ScanJournal | undefined;
  const getJournal = () => journal ??= new ScanJournal(databasePath);
  const getAccounts = () => accountRoutes ??= createAccountRouter({
    ...(accountOptions ?? {
      dbPath: databasePath,
      cookieName: env.CLOSER_ACCOUNT_COOKIE ?? 'closer_rail_acct',
      secureCookies: env.CLOSER_ACCOUNT_COOKIE_SECURE === '1',
      allowedOrigins: env.CLOSER_APP_ORIGIN ? env.CLOSER_APP_ORIGIN.split(',').map(value => value.trim()).filter(Boolean) : undefined,
    }),
    resolveScanItem: (workspaceId,piece) => getJournal().resolveItem(workspaceId,piece),
    validateScanPieces: (workspaceId, pieces, previousPieces) => {
      getJournal().validatePieces(workspaceId,pieces,previousPieces);
      accountOptions?.validateScanPieces?.(workspaceId,pieces,previousPieces);
    },
  });
  app.use('/api/account', (req, res, next) => getAccounts().router(req,res,next));
  app.locals.closeAccounts = () => { accountRoutes?.close(); accountRoutes = undefined; journal?.close(); journal = undefined; };

  app.get('/api/scan/status', (_req, res) => {
    // A configured key is not proof that the provider accepted it. Only journal rows prove calls.
    const status = journal?.status() ?? (existsSync(databasePath) ? getJournal().status() : {
      reservedMicroUsd:0, estimatedCostMicroUsd:0, pendingAttempts:0, scans:0, successfulLiveCalls:0,
    });
    res.setHeader('Cache-Control','no-store');
    res.json({ mode: scanMode(), models: { spark: 'muse-spark-1.3', sam: 'sam-3.1' }, ...status,
      spentMicroUsd: status.estimatedCostMicroUsd, capMicroUsd: scanBudget(), costBasis:'local-estimate',
      liveRequiresAccount:true,
    });
  });

  app.post('/api/scan', express.json({ limit: '16mb' }), async (req, res) => {
    const mode = scanMode();
    res.setHeader('Cache-Control','no-store');
    if (mode === 'off') return res.status(503).json({ ok: false, code: 'META_DISABLED', detail: 'model calls are switched off on this server (CLOSER_KILL=1)', mode });
    if (mode === 'no_key') return res.status(503).json({ ok: false, code: 'META_KEY_MISSING', detail: 'no Meta key on this server: add MODEL_API_KEY to the server environment', mode });
    const body = (req.body ?? {}) as Record<string, unknown>;
    let workspaceId: string | null = null;
    if (mode === 'live') {
      const accounts = getAccounts();
      if (!accounts.originAllowed(req)) return res.status(403).json({ok:false,code:'ORIGIN_DENIED',detail:'Open this app to scan your photo.',mode});
      const account = accounts.accountForRequest(req);
      if (!account) return res.status(401).json({ok:false,code:'SESSION_REQUIRED',detail:'Sign in before using Meta photo analysis.',mode});
      if (body.workspaceId !== account.workspaceId) return res.status(409).json({ok:false,code:'ACCOUNT_CHANGED',detail:'Your account changed. Open the photo again before scanning.',mode});
      workspaceId = account.workspaceId;
    }
    if (limited(req.ip ?? 'unknown')) return res.status(429).json({ ok: false, code: 'CALL_CAP_REACHED', detail: 'too many scans from this address; try again in 10 minutes', mode });
    const raw = (scanOptions.transportFor ?? transportFor)(mode);
    if (!raw) return res.status(503).json({ ok: false, code: 'META_KEY_MISSING', detail: 'no transport', mode });
    const scanId = `scan-${randomUUID()}`;
    const deadline = Date.now() + 90_000;
    let localRefusal: 'budget' | 'deadline' | null = null;
    const transport = workspaceId ? getJournal().transport(scanId,workspaceId,scanBudget(),raw,deadline,reason=>{localRefusal=reason;}) : raw;
    try {
      const r = await scanPhoto({ jpegBase64: body.jpegBase64, pngBase64: body.pngBase64, sentence: body.sentence, mode: body.mode }, {
        transport, source: mode === 'live' ? 'live' : 'mock',
        sleep: ms => new Promise(resolve => setTimeout(resolve,Math.max(0,Math.min(ms,2000,deadline-Date.now())))),
      });
      const calls = workspaceId ? getJournal().calls(scanId,workspaceId) : r.calls;
      const receiptId = workspaceId && r.ok ? getJournal().receipt(scanId,workspaceId,r) : undefined;
      // Local refusals are not provider attempts. The call journal is the response authority.
      if (!r.ok && localRefusal) {
        return res.status(localRefusal==='budget'?429:504).json({ok:false,code:localRefusal==='budget'?'CALL_CAP_REACHED':'SCAN_TIMEOUT',detail:localRefusal==='budget'?'This server reached its estimated model-call budget.':'The scan reached its time limit. Please try again.',calls,mode});
      }
      if (r.ok && localRefusal) {
        r.notes=r.notes.filter(note=>!note.startsWith('SAM did not return usable masks'));
        r.notes.push(localRefusal==='budget'?'SAM was not called because the local scan budget was reached. Showing Spark box crops.':'SAM was not called because the scan reached its time limit. Showing Spark box crops.');
      }
      return res.status(r.ok ? 200 : r.status).json({ ...r, calls, mode, ...(receiptId ? {receiptId} : {}) });
    } catch {
      // No provider payload, credential, photo or exception string is written to a log.
      return res.status(500).json({ ok: false, code: 'INTERNAL', detail: 'the scan could not be completed; any attempted calls remain recorded', mode });
    }
  });
  // Body problems answer as JSON the screen can show, without a stack trace in the log.
  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    const type = (err as { type?: unknown } | null)?.type;
    if (type === 'entity.too.large') return res.status(413).json({ ok: false, code: 'BAD_INPUT', detail: 'request over 16 MB: pick a smaller photo' });
    if (type === 'entity.parse.failed') return res.status(400).json({ ok: false, code: 'BAD_INPUT', detail: 'request body is not JSON' });
    return next(err);
  });
  return app;
}

async function main() {
  const app = createApp();
  const port = Number(env.PORT ?? 3000);
  const http = createHttpServer(app);
  http.on('close', () => app.locals.closeAccounts());
  if (env.NODE_ENV === 'production') {
    const dist = join(process.cwd(), 'dist');
    if (!existsSync(dist)) throw new Error('dist/ is missing: run npm run build first');
    app.use(express.static(dist));
    // The garment photos are referenced as /src/assets/... strings (not imported), so the build does
    // not copy them: serve them from the source folder. A missing file is a 404, never index.html.
    const assets = join(process.cwd(), 'src', 'assets');
    if (existsSync(assets)) app.use('/src/assets', express.static(assets, { fallthrough: false }));
    app.get(/^(?!\/api\/)[^.]*$/, (_req, res) => res.sendFile(join(dist, 'index.html')));
  } else {
    const { createServer } = await import('vite');
    // HMR rides on this same server and port (no second websocket port); AI Studio turns it off with DISABLE_HMR=true.
    const vite = await createServer({ server: { middlewareMode: true, hmr: env.DISABLE_HMR === 'true' ? false : { server: http } }, appType: 'spa' });
    app.use(vite.middlewares);
  }
  http.listen(port, '0.0.0.0', () => console.log(`Closer on http://localhost:${port} · scan mode ${scanMode()}`));
}

if (!env.CLOSER_NO_LISTEN) void main();
