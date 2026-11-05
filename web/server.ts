// Local server for the five screens (§3-7): / (Try), /app, /w/demo-rc1, /admin, /version.
// Mock mode is the default. CLOSER_MODE=real refuses to start without MODEL_API_KEY.
// Run: npm run ui   (http://localhost:8787)
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, dirname, extname } from 'node:path';
import { SqliteLedger } from '../store/ledger.ts';
import { CloserService, isPublicCopy } from '../engine/service.ts';
import { createPortsFromEnv } from '../adapters/index.ts';
import { RealModeRefused } from '../adapters/transport.ts';
import { createPhotoLibrary, CHIPS, rolesOutside } from '../fixtures/photos.ts';
import { FXH_ROLES, OUTSIDE_PHOTO_ROLES, seedItems } from '../fixtures/fxh.ts';
import { KILL_TTL_MS, capsFromEnv, killActive, visitorDayCap } from '../engine/caps.ts';
import { NAMED_RGB } from '../engine/color.ts';
import { addDays, isIsoDate, kstDateOf } from '../shared/dates.ts';
import { BUILD_CHIP, LABELS, livePerception, sampleWardrobe } from '../shared/labels.ts';
import { EST_MICRO_USD } from '../adapters/responses.ts';
import { wonderRequestFromJson } from '../adapters/wonder.ts';
import { evidenceLinks } from '../engine/links.ts';
import type { WorkspaceRow } from '../shared/ledger.ts';
import { ExtrasStore } from '../store/extras.ts';
import { PhotoStore } from '../store/photos.ts';
import { FeatureService } from '../engine/features.ts';
import { closetHistory, closetItems, sampleEvidence, HISTORY_DAYS } from '../fixtures/closet.ts';
import { CATEGORY_LABEL, LOOK_CATEGORIES } from '../engine/looks.ts';
import { INTENT_CHIPS } from '../engine/intent.ts';
import { maskToleranceFromEnv } from '../engine/validate.ts';
import { BadRequest, RateLimiter, SECURITY_HEADERS, clientIp, readJson, tokenMatches } from './guard.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const PUBLIC = join(ROOT, 'web', 'public');
const env = process.env;
const PORT = Number(env.CLOSER_PORT || 8787);
const HOST = env.CLOSER_HOST || '127.0.0.1'; // loopback only (local, and behind Caddy on the VM); the container image sets 0.0.0.0
const DB_PATH = env.CLOSER_DB_PATH || join(ROOT, '.data', 'closer.db');
const STARTED_AT = new Date().toISOString();

// Release sha: a deploy writes BUILD_SHA next to the code (no .git on the server); locally, git.
let SHA = (env.CLOSER_BUILD_SHA ?? '').trim() || 'unknown';
if (SHA === 'unknown' && existsSync(join(ROOT, 'BUILD_SHA'))) SHA = readFileSync(join(ROOT, 'BUILD_SHA'), 'utf8').trim() || 'unknown';
if (SHA === 'unknown') {
  try {
    SHA = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    // not a git checkout
  }
}

const lib = createPhotoLibrary();
let demoOffsetDays = 0;
const clock = {
  now: () => new Date(),
  today: () => addDays(isIsoDate(env.CLOSER_TODAY) ? env.CLOSER_TODAY : kstDateOf(new Date()), demoOffsetDays),
};

let mode: 'mock' | 'real';
let svc: CloserService;
let ledger: SqliteLedger;
let feat: FeatureService;
let extras: ExtrasStore;
let uploads: PhotoStore;
try {
  const p = createPortsFromEnv(env, lib, {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    nowMs: () => performance.now(),
    nowIso: () => new Date().toISOString(),
  });
  mode = p.mode;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  // Money caps: the provisional defaults, with the two owner-raisable caps read from the environment
  // (CLOSER_VISITOR_DAY_USD, CLOSER_APP_TOTAL_USD). Stored on the flags row, so a restart with
  // different values re-applies them.
  ledger = new SqliteLedger(DB_PATH, { kill: { on: false, setAt: null, ttlMs: KILL_TTL_MS }, caps: capsFromEnv(env) });
  ledger.setFlag('caps', capsFromEnv(env));
  uploads = new PhotoStore(join(dirname(DB_PATH), 'photos'));
  // Sample photos for everyone; uploaded photos only through routes that check their workspace.
  const photoSource = { get: (id: string) => uploads.get(id) ?? lib.get(id) };
  // CLOSER_MASK_TOLERANCE_PX fixes the mask-in-box tolerance; unset → max(8 px, 5 % of the box side).
  svc = new CloserService({ ledger, ports: p.ports, clock, photos: photoSource, mode, maskTolerancePx: maskToleranceFromEnv(env) });
  extras = new ExtrasStore(DB_PATH);
  feat = new FeatureService({ ledger, extras, today: clock.today, now: clock.now, revision: SHA });
} catch (e) {
  if (e instanceof RealModeRefused) {
    console.error(`Refusing to start: ${e.message}`);
    process.exit(2);
  }
  throw e;
}

function ensureWorkspace(id: string, kind: WorkspaceRow['kind'], publicReadOnly: boolean, roles: readonly string[]) {
  if (ledger.getWorkspace(id)) return;
  ledger.createWorkspace({ workspaceId: id, kind, publicReadOnly, seedRef: 'fx-h', createdOn: clock.today() }, { items: seedItems(roles), since: clock.today() });
}
ensureWorkspace('owner', 'real', false, OUTSIDE_PHOTO_ROLES);
ensureWorkspace('demo-rc1', 'demo', true, FXH_ROLES.map((r) => r.role));

// ---------- helpers ----------
function send(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
// Per-address limits (web/guard.ts): 30 workspace-creating POSTs and 60 model-call-starting POSTs
// per 10 minutes. The address is the socket's unless CLOSER_TRUST_PROXY=1 (the deploy kit's Caddy
// is then the one peer that can reach the server and writes X-Forwarded-For).
const TRUST_PROXY = env.CLOSER_TRUST_PROXY === '1';
const createLimit = new RateLimiter(30, 10 * 60_000);
const callLimit = new RateLimiter(60, 10 * 60_000);
const CALL_ACTIONS = new Set(['photo', 'propose', 'next', 'say', 'anchor', 'upload']);
/** True (and a 429 already sent) when `bucket` has no token left for this request's address. */
function limited(req: IncomingMessage, res: ServerResponse, bucket: RateLimiter): boolean {
  const wait = bucket.take(clientIp(req, TRUST_PROXY));
  if (wait === null) return false;
  const secs = Math.max(1, Math.ceil(wait / 1000));
  res.setHeader('Retry-After', String(secs));
  // CALL_CAP_REACHED is the nearest of the 30 frozen reason codes (§4-3); the status line says which cap.
  send(res, 429, { ok: false, code: 'CALL_CAP_REACHED', detail: `too many requests from this address; try again in ${secs} s` });
  return true;
}
function adminAllowed(req: IncomingMessage): boolean {
  const token = env.CLOSER_ADMIN_TOKEN;
  if (token) return tokenMatches(req.headers['x-admin-token'], token);
  return mode === 'mock'; // local mock only; real mode needs CLOSER_ADMIN_TOKEN
}
/**
 * The owner's real wardrobe ('real' workspace) is private in real mode: reads and writes need the
 * owner token (same value as CLOSER_ADMIN_TOKEN). Visitor, demo and sample-closet copies stay open.
 */
function ownerAllowed(req: IncomingMessage, ws: WorkspaceRow): boolean {
  if (ws.kind !== 'real' || mode === 'mock') return true;
  return tokenMatches(req.headers['x-admin-token'], env.CLOSER_ADMIN_TOKEN);
}

function banner(ws: WorkspaceRow | null, sessionId: string | null) {
  const flags = ledger.getFlags();
  const now = clock.now();
  const spend = ledger.spend({ sessionId, kstDate: kstDateOf(now) });
  const caps = flags.caps;
  const usd = (m: number) => `$${(m / 1_000_000).toFixed(2)}`;
  const capLine = `Caps: total ${usd(caps.appTotalMicroUsd)} · visitor/day ${usd(visitorDayCap(caps, now))} · session ${usd(caps.sessionMicroUsd)} · spent ${usd(spend.appTotal)}`;
  const hero = EST_MICRO_USD.spark1 + EST_MICRO_USD.sam + EST_MICRO_USD.spark2;
  let liveText: string;
  if (ws && isPublicCopy(ws)) {
    const left = Math.max(0, Math.floor((visitorDayCap(caps, now) - spend.visitorDay) / hero));
    liveText = left > 0 ? livePerception(left) : LABELS.replayAndLedger;
  } else {
    liveText = livePerception(Math.max(0, Math.floor((caps.appTotalMicroUsd - spend.appTotal) / hero)));
  }
  if (killActive(flags.kill, now)) return { kind: 'kill', text: LABELS.killBanner, capLine, ifLive: mode === 'mock' ? `If live: ${liveText}` : liveText };
  if (mode === 'mock') return { kind: 'mock', text: LABELS.mockBanner, capLine, ifLive: `If live: ${liveText}` };
  return { kind: liveText === LABELS.replayAndLedger ? 'replay' : 'live', text: liveText, capLine, ifLive: '' };
}

function publicPhotos() {
  return lib.list().map((p) => ({ photoId: p.photoId, title: p.title, url: p.url, w: p.w, h: p.h, count: p.garments.length }));
}

const sessions = new Map<string, string>(); // workspaceId → sessionId (visitor forks)

// ---------- API ----------
async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  if (path === '/api/version') {
    return send(res, 200, { sha: SHA, builtAt: STARTED_AT, mode, node: process.version, demoRc1StateHash: ledger.stateHash('demo-rc1'), buildChip: BUILD_CHIP, liveCalls: ledger.countLiveCalls() });
  }
  if (path === '/api/photos') return send(res, 200, { photos: publicPhotos(), chips: CHIPS, intentChips: INTENT_CHIPS, palette: NAMED_RGB, labels: LABELS, buildChip: BUILD_CHIP });
  if (path === '/api/try/start' && method === 'POST') {
    if (limited(req, res, createLimit)) return;
    const body = await readJson(req);
    const photo = lib.get(String(body.photoId ?? ''));
    if (!photo) return send(res, 400, { ok: false, code: 'UNSUPPORTED_IMAGE', detail: 'unknown sample photo' });
    const wsId = `try-${randomUUID().slice(0, 8)}`;
    const sessionId = `sess-${randomUUID().slice(0, 8)}`;
    const roles = rolesOutside(photo.photoId);
    ledger.createWorkspace({ workspaceId: wsId, kind: 'visitor', publicReadOnly: false, seedRef: `fx-h/${photo.photoId}`, createdOn: clock.today() }, { items: seedItems(roles), since: clock.today() }, clock.now().toISOString());
    sessions.set(wsId, sessionId);
    return send(res, 200, { workspaceId: wsId, sessionId, seededLabel: sampleWardrobe(roles.length) });
  }
  if (path === '/api/banner/visitor') return send(res, 200, banner({ workspaceId: 'visitor-preview', kind: 'visitor', publicReadOnly: false, seedRef: null, ledgerRevision: 0, createdOn: clock.today() }, null));
  if (path === '/api/closet/start' && method === 'POST') {
    // A private copy of the sample closet per visitor: 12 sample items and a synthetic 75-day wear history.
    if (limited(req, res, createLimit)) return;
    await readJson(req);
    const wsId = `closet-${randomUUID().slice(0, 8)}`;
    const since = addDays(clock.today(), -HISTORY_DAYS);
    ledger.createWorkspace({ workspaceId: wsId, kind: 'rehearsal', publicReadOnly: false, seedRef: 'sample-closet', createdOn: since }, { items: closetItems(), since });
    let i = 0;
    for (const h of closetHistory(clock.today())) {
      const r = svc.recordPastWear(wsId, { eventId: `${wsId}-hist-${++i}`, actor: 'demo_script', expectedRevision: ledger.getWorkspace(wsId)!.ledgerRevision, itemIds: h.itemIds, occurredAt: h.occurredAt });
      if (!r.ok) return send(res, 500, { ok: false, detail: `sample history failed: ${r.code}` });
    }
    return send(res, 200, { workspaceId: wsId, label: `Sample closet · ${closetItems().length} sample items · synthetic wear history (${HISTORY_DAYS} days)` });
  }
  if (path === '/api/looks') {
    const cat = url.searchParams.get('category') ?? undefined;
    return send(res, 200, { categories: LOOK_CATEGORIES.map((c) => ({ id: c, label: CATEGORY_LABEL[c] })), looks: feat.looks(cat) });
  }
  if (path === '/api/net' && method === 'POST') {
    const b = await readJson(req);
    return send(res, 200, feat.net(Number(b.price), b.platform as never, b.fees ?? []));
  }
  if (path === '/api/demo-clock' && method === 'POST') {
    if (!adminAllowed(req)) return send(res, 403, { ok: false, code: 'SCOPE_DENIED', detail: 'demo clock is local mock or admin only' });
    const body = await readJson(req);
    const days = body.days ?? 0;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 0 || days > 7) return send(res, 400, { ok: false, code: 'INVALID_TRANSITION', detail: 'days must be a whole number from 0 to 7' });
    demoOffsetDays = days;
    return send(res, 200, { today: clock.today(), offsetDays: demoOffsetDays, label: demoOffsetDays ? LABELS.demoClockPlusOne : null });
  }
  if (path === '/api/admin' && method === 'GET') {
    if (!adminAllowed(req)) return send(res, 403, { ok: false, code: 'SCOPE_DENIED', detail: 'admin token required' });
    const flags = ledger.getFlags();
    const now = clock.now();
    return send(res, 200, {
      mode, flags, killActive: killActive(flags.kill, now), killRemainingMs: flags.kill.on && flags.kill.setAt ? Math.max(0, new Date(flags.kill.setAt).getTime() + flags.kill.ttlMs - now.getTime()) : 0,
      visitorCapNow: visitorDayCap(flags.caps, now), spend: ledger.spend({ sessionId: null, kstDate: kstDateOf(now) }), calls: ledger.listCalls(30),
      workspaces: ledger.listWorkspaces().length, adminOpen: !env.CLOSER_ADMIN_TOKEN,
    });
  }
  if (path === '/api/admin/kill' && method === 'POST') {
    if (!adminAllowed(req)) return send(res, 403, { ok: false, code: 'SCOPE_DENIED', detail: 'admin token required' });
    const body = await readJson(req);
    const on = body.on === true;
    ledger.setFlag('kill', { on, setAt: on ? clock.now().toISOString() : null, ttlMs: KILL_TTL_MS });
    return send(res, 200, { ok: true, kill: ledger.getFlags().kill });
  }

  const m = path.match(/^\/api\/ws\/([A-Za-z0-9_-]+)\/([a-z]+)(?:\/([A-Za-z0-9_.-]+))?$/);
  if (!m) return send(res, 404, { ok: false, detail: 'not found' });
  const [, wsId, action, arg] = m;
  const ws = ledger.getWorkspace(wsId);
  if (!ws) return send(res, 404, { ok: false, code: 'SCOPE_DENIED', detail: 'unknown workspace' });
  if (!ownerAllowed(req, ws)) return send(res, 403, { ok: false, code: 'SCOPE_DENIED', detail: 'owner sign-in required' });
  // Session for the $0.25 cap: a Try fork's session while this process remembers it, else the public
  // copy itself (sample closets, and Try forks after a restart), so the cap binds per copy and is read
  // back from the persisted call rows. The owner's own wardrobe has no session: it is behind the owner
  // token and under the app total.
  const sessionId = sessions.get(wsId) ?? (isPublicCopy(ws) ? wsId : null);
  const sample = ws.seedRef === 'sample-closet' ? sampleEvidence(clock.today()) : [];
  if (method === 'GET' && action === 'review') return send(res, 200, feat.review(wsId, Number(url.searchParams.get('window') ?? 60)));
  if (method === 'GET' && action === 'market' && arg) return send(res, 200, feat.market(wsId, arg, sample));
  if (method === 'GET' && action === 'coverage') return send(res, 200, feat.coverage(wsId, sample));
  if (method === 'GET' && action === 'ledger') return send(res, 200, feat.closetLedger(wsId, sample));
  if (method === 'GET' && action === 'drafts') return send(res, 200, { drafts: feat.drafts(wsId) });
  if (method === 'GET' && action === 'look' && arg) return send(res, 200, feat.matchLook(wsId, arg));
  if (method === 'GET' && action === 'collection') return send(res, 200, feat.collection(wsId));
  if (method === 'GET' && action === 'decide' && arg) {
    const hz = url.searchParams.get('horizon');
    return send(res, 200, feat.decisionView(wsId, { itemId: arg, horizonDays: hz === null ? undefined : Number(hz) }, sample));
  }
  if (method === 'GET' && action === 'decisions') return send(res, 200, { decisions: feat.decisions(wsId, arg || undefined) });
  if (method === 'GET' && action === 'photos') return send(res, 200, { photos: uploads.list(wsId) });
  if (method === 'GET' && action === 'photo' && arg) {
    const own = uploads.list(wsId).some((p) => p.photoId === arg);
    const bytes = own ? uploads.jpegBytes(arg) : null;
    return bytes ? send(res, 200, bytes, 'image/jpeg') : send(res, 404, { ok: false, detail: 'no such photo' });
  }
  if (method === 'GET' && action === 'view') return send(res, 200, { ...svc.view(wsId), banner: banner(ws, sessionId), sessionId });
  if (method === 'GET' && action === 'event' && arg) {
    const r = ledger.lookupEvent(wsId, arg);
    return send(res, r ? 200 : 404, r ? r.response : { ok: false, detail: 'no such event' });
  }
  if (method !== 'POST') return send(res, 405, { ok: false });
  if (CALL_ACTIONS.has(action) && limited(req, res, callLimit)) return;
  if (action === 'upload') {
    // Owner wardrobes only (visitors use the sample photos). Two copies from one canvas: JPEG for the models, PNG for pixels.
    if (ws.kind !== 'real') return send(res, 403, { ok: false, code: 'SCOPE_DENIED', detail: 'uploads are for your own wardrobe' });
    const u = await readJson(req, 12 * 1024 * 1024);
    try {
      const meta = uploads.save(wsId, Buffer.from(String(u.jpegBase64 ?? ''), 'base64'), Buffer.from(String(u.pngBase64 ?? ''), 'base64'), clock.now().toISOString());
      return send(res, 200, { ok: true, ...meta });
    } catch (e) {
      return send(res, 400, { ok: false, code: 'UNSUPPORTED_IMAGE', detail: e instanceof Error ? e.message : String(e) });
    }
  }
  const b = await readJson(req);
  const who = { eventId: String(b.eventId ?? ''), actor: 'human' as const, expectedRevision: Number(b.expectedRevision ?? -1) };
  switch (action) {
    case 'photo': {
      const photoId = String(b.photoId ?? '');
      // An uploaded photo can be used only in the wardrobe it was uploaded to.
      if (photoId.startsWith('up_') && !uploads.list(wsId).some((p) => p.photoId === photoId)) return send(res, 404, { ok: false, code: 'SCOPE_DENIED', detail: 'no such photo in this wardrobe' });
      const chip = CHIPS.find((c) => c.chipId === b.chipId);
      // Visitors: fixed sentence chips only, no free text (RT-13). The owner may write their own sentence.
      const free = ws.kind === 'real' && typeof b.sentence === 'string' && b.sentence.trim() ? b.sentence.trim() : null;
      if (!chip && !free) return send(res, 400, { ok: false, code: 'META_REQUEST_REJECTED', detail: 'pick one of the fixed sentences' });
      return send(res, 200, await svc.startPhoto(wsId, { photoId, sentence: free ?? chip!.text, sessionId }));
    }
    case 'photodelete':
      return send(res, 200, { ok: uploads.delete(wsId, String(b.photoId ?? '')) });
    case 'confirm':
      return send(res, 200, svc.confirmCards(wsId, { operationId: String(b.operationId), eventIds: (b.eventIds as string[]) ?? [], actor: 'human', expectedRevision: who.expectedRevision, answers: b.answers as never }));
    case 'propose':
      return send(res, 200, await svc.propose(wsId, { operationId: String(b.operationId) }));
    case 'answer':
      return send(res, 200, svc.answer(wsId, { operationId: String(b.operationId), actor: 'human', formality: b.formality as never }));
    case 'cancel':
      return send(res, 200, svc.cancel(wsId, { operationId: String(b.operationId), actor: 'human' }));
    case 'lock':
      return send(res, 200, svc.lock(wsId, { ...who, operationId: String(b.operationId), optionIndex: Number(b.optionIndex) }));
    case 'keep':
      return send(res, 200, svc.keepAsIs(wsId, { ...who, operationId: String(b.operationId) }));
    case 'availability':
      return send(res, 200, svc.setAvailability(wsId, { ...who, itemId: String(b.itemId), state: b.state as never }));
    case 'wear':
      return send(res, 200, svc.wore(wsId, { ...who, planId: String(b.planId) }));
    case 'unlock':
      return send(res, 200, svc.unlock(wsId, { ...who, planId: String(b.planId) }));
    case 'undo':
      return send(res, 200, svc.undoWear(wsId, { ...who, wearEventId: String(b.wearEventId) }));
    case 'next':
      return send(res, 200, await svc.startNext(wsId, { fromPlanId: String(b.fromPlanId), sessionId }));
    case 'say':
      return send(res, 200, await svc.startAnchorFromSentence(wsId, { sentence: String(b.sentence ?? ''), sessionId }));
    case 'anchor':
      return send(res, 200, svc.startAnchor(wsId, { anchorItemIds: Array.isArray(b.anchorItemIds) ? (b.anchorItemIds as string[]) : [], direction: b.direction as never, rainPct: typeof b.rainPct === 'number' ? b.rainPct : null, sessionId }));
    case 'reviewchoice':
      return send(res, 200, feat.choose(wsId, { itemId: String(b.itemId), action: String(b.action), note: (b.note as string) ?? null }));
    case 'exempt':
      return send(res, 200, feat.exempt(wsId, { itemId: String(b.itemId), reason: String(b.reason), reviewAfter: String(b.reviewAfter), note: (b.note as string) ?? null }));
    case 'evidence':
      return send(res, 200, feat.addEvidence(wsId, { ...(b as object), itemId: String(b.itemId) } as never));
    case 'draft':
      return send(res, 200, feat.draft(wsId, { itemId: String(b.itemId), kind: String(b.kind), platform: (b.platform as string) ?? null, facts: (b.facts as never) ?? {}, price: typeof b.price === 'number' ? b.price : null }));
    case 'draftmove':
      return send(res, 200, feat.moveDraft(wsId, { draftId: String(b.draftId), to: String(b.to), body: typeof b.body === 'string' ? b.body : undefined }));
    case 'target':
      return send(res, 200, feat.setTarget(wsId, { lookId: String(b.lookId ?? ''), on: b.on === true }));
    case 'wonder': {
      // The owner's own prompt to Muse Wonder (or Spark). Caps and the kill switch apply; links come back sorted by platform for the owner to open.
      const parsed = wonderRequestFromJson(b);
      if (typeof parsed === 'string') return send(res, 400, { ok: false, code: 'META_REQUEST_REJECTED', detail: parsed });
      const r = await svc.askWonder(wsId, { request: parsed, sessionId });
      return send(res, 200, r.ok ? { ...r, links: evidenceLinks(r.result) } : r);
    }
    case 'decide':
      return send(res, 200, feat.decide(wsId, {
        itemId: String(b.itemId ?? ''), choice: String(b.choice ?? ''), horizonDays: b.horizonDays === undefined ? undefined : Number(b.horizonDays),
        platform: String(b.platform ?? ''), askPrice: b.askPrice, fees: b.fees,
        namedUses: b.namedUses, note: typeof b.note === 'string' ? b.note : null, clientKey: typeof b.clientKey === 'string' ? b.clientKey : null,
      }, sample));
    default:
      return send(res, 404, { ok: false, detail: 'unknown action' });
  }
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const PAGES = new Set(['/', '/try', '/app', '/w/demo-rc1', '/admin', '/version', '/today', '/closet', '/closet/3d', '/discover']);
/** Third-party browser modules served from the installed, version-pinned package (never copied into the repository). */
const VENDOR: Record<string, string> = { '/static/vendor/three.module.min.js': join(ROOT, 'node_modules', 'three', 'build', 'three.module.min.js') };

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (path.startsWith('/api/')) return await api(req, res, url);
    if (PAGES.has(path)) return send(res, 200, readFileSync(join(PUBLIC, 'index.html')), TYPES['.html']);
    if (VENDOR[path]) return existsSync(VENDOR[path]) ? send(res, 200, readFileSync(VENDOR[path]), TYPES['.js']) : send(res, 404, 'run npm install', 'text/plain');
    if (path.startsWith('/static/')) {
      const file = join(PUBLIC, path.slice('/static/'.length));
      if (!file.startsWith(PUBLIC) || !existsSync(file)) return send(res, 404, 'not found', 'text/plain');
      return send(res, 200, readFileSync(file), TYPES[extname(file)] ?? 'application/octet-stream');
    }
    return send(res, 404, 'not found', 'text/plain');
  } catch (e) {
    if (e instanceof BadRequest) return send(res, e.status, { ok: false, code: 'META_REQUEST_REJECTED', detail: e.message });
    // Logged here, not echoed: a parser or stack message is for the operator, not the caller.
    console.error(`${new Date().toISOString()} ${req.method ?? ''} ${req.url ?? ''} failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    send(res, 500, { ok: false, detail: 'internal error' });
  }
});

// Try forks (kind 'visitor') are disposable: 24 hours after creation their ledger rows, side-table
// rows and photos go; call rows stay (money ledger). Runs at startup and hourly; the timer never
// keeps the process alive. Owner, demo and sample-closet copies are not touched.
const VISITOR_TTL_MS = 24 * 3600_000;
function sweepVisitorWorkspaces(): number {
  const cutoff = new Date(clock.now().getTime() - VISITOR_TTL_MS).toISOString();
  let n = 0;
  for (const id of ledger.staleVisitorWorkspaces(cutoff)) {
    if (!ledger.deleteVisitorWorkspace(id)) continue;
    extras.deleteWorkspace(id);
    for (const p of uploads.list(id)) uploads.delete(id, p.photoId);
    sessions.delete(id);
    n++;
  }
  if (n) console.log(`swept ${n} visitor workspace(s) older than 24 h`);
  return n;
}
sweepVisitorWorkspaces();
setInterval(sweepVisitorWorkspaces, 3600_000).unref();

server.listen(PORT, HOST, () => {
  console.log(`Closer (${mode} mode) on http://localhost:${PORT}  — screens: / · /app · /w/demo-rc1 · /admin · /version`);
});
