// Closer (Google AI Studio version) server: serves the app and one route that sends a photo to
// Meta's models (server/scan.ts). The Meta key is read from the server environment only
// (MODEL_API_KEY, or META_API_KEY as set in AI Studio Settings -> Secrets). It never reaches the
// browser bundle, a log line or a response.
import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRealTransport, type Transport } from './server/closer/adapters/transport.ts';
import { EST_MICRO_USD } from './server/closer/adapters/responses.ts';
import { createFakeMetaTransport } from './server/fakeMeta.ts';
import { scanPhoto } from './server/scan.ts';

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

// Spend cap for this process: every scan is gated on its estimate before any call.
const capMicroUsd = Math.round(Math.min(50, Math.max(0, Number(env.CLOSER_SCAN_BUDGET_USD ?? 2) || 0)) * 1_000_000);
const EST_SCAN = EST_MICRO_USD.spark1 + EST_MICRO_USD.sam;
let spentMicroUsd = 0;
let scans = 0;

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

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  app.get('/api/scan/status', (_req, res) => {
    res.json({ mode: scanMode(), models: { spark: 'muse-spark-1.3', sam: 'sam-3.1' }, scans, spentMicroUsd, capMicroUsd });
  });

  app.post('/api/scan', express.json({ limit: '16mb' }), async (req, res) => {
    const mode = scanMode();
    if (mode === 'off') return res.status(503).json({ ok: false, code: 'META_DISABLED', detail: 'model calls are switched off on this server (CLOSER_KILL=1)', mode });
    if (mode === 'no_key') return res.status(503).json({ ok: false, code: 'META_KEY_MISSING', detail: 'no Meta key on this server: add MODEL_API_KEY in AI Studio Settings -> Secrets', mode });
    if (limited(req.ip ?? 'unknown')) return res.status(429).json({ ok: false, code: 'CALL_CAP_REACHED', detail: 'too many scans from this address; try again in 10 minutes', mode });
    if (mode === 'live' && spentMicroUsd + EST_SCAN > capMicroUsd) return res.status(429).json({ ok: false, code: 'CALL_CAP_REACHED', detail: 'this server reached its spend cap for model calls', mode });
    const transport = transportFor(mode);
    if (!transport) return res.status(503).json({ ok: false, code: 'META_KEY_MISSING', detail: 'no transport', mode });
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const r = await scanPhoto({ jpegBase64: body.jpegBase64, pngBase64: body.pngBase64, sentence: body.sentence, mode: body.mode }, { transport, source: mode === 'live' ? 'live' : 'mock' });
      if (mode === 'live') spentMicroUsd += r.calls.reduce((s, c) => s + c.costMicroUsd, 0);
      if (r.ok) scans++;
      return res.status(r.ok ? 200 : r.status).json({ ...r, mode });
    } catch (e) {
      // The operator gets the stack; the caller gets a plain line. Never the key.
      console.error(`${new Date().toISOString()} POST /api/scan failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      return res.status(500).json({ ok: false, code: 'INTERNAL', detail: 'the scan failed on the server', mode });
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
