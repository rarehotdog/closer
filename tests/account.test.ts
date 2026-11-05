// Account registration, workspace claiming, HttpOnly cookie sessions, and private wardrobe isolation.
import { ROOT } from './helpers.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { encodePng } from '../engine/png.ts';
import {
  ACCT_COOKIE, formatAccountCookie, hashPassword, normalizeHandle,
  readCookie, validPassword, verifyPassword,
} from '../web/guard.ts';

const dir = join(ROOT, '.data', 'test');
mkdirSync(dir, { recursive: true });
const cleanupPaths: string[] = [];
const procs: ChildProcess[] = [];

after(() => {
  for (const p of procs) {
    try { p.kill('SIGTERM'); } catch { /* exited */ }
  }
  for (const p of cleanupPaths) {
    rmSync(p, { recursive: true, force: true });
    for (const suf of ['', '-wal', '-shm']) rmSync(p + suf, { force: true });
  }
});

async function startTempServer(tag: string): Promise<{ base: string; stop: () => void }> {
  const db = join(dir, `acct-${process.pid}-${tag}.db`);
  cleanupPaths.push(db, join(dir, 'photos'));
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'web', 'server.ts')], {
    cwd: ROOT,
    env: { ...process.env, CLOSER_MODE: 'mock', CLOSER_HOST: '127.0.0.1', CLOSER_PORT: '0', CLOSER_DB_PATH: db },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(child);
  const port = await new Promise<number>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`server startup timed out: ${out}`)), 8000);
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      const m = out.match(/http:\/\/localhost:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (${code}): ${out}`));
    });
  });
  return { base: `http://127.0.0.1:${port}`, stop: () => { try { child.kill('SIGTERM'); } catch { /* ok */ } } };
}

async function reqJson(base: string, path: string, opts: { method?: string; body?: unknown; cookie?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.Cookie = opts.cookie;
  let bodyStr: string | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    bodyStr = JSON.stringify(opts.body);
    headers['Content-Length'] = String(Buffer.byteLength(bodyStr, 'utf8'));
  }
  const u = new URL(path, base);
  return new Promise<{ status: number; data: Record<string, unknown>; setCookie: string }>((resolve, reject) => {
    const req = httpRequest(
      { hostname: u.hostname, port: Number(u.port), path: u.pathname + u.search, method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'), headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = res.headers['set-cookie'];
          const setCookie = Array.isArray(raw) ? raw[0] ?? '' : raw ?? '';
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
          resolve({ status: res.statusCode ?? 0, data, setCookie });
        });
      },
    );
    req.on('error', reject);
    if (bodyStr !== undefined) req.write(bodyStr);
    req.end();
  });
}

function cookiePair(setCookie: string): string {
  return setCookie.split(';')[0] ?? '';
}

test('AC-01 guard helpers: handle normalization, password bounds, scrypt verification, and HttpOnly cookie formatting', async () => {
  assert.equal(normalizeHandle('  Tyler.Member@Closer.Invalid '), 'tyler.member@closer.invalid');
  assert.equal(normalizeHandle('a'), null);
  assert.equal(normalizeHandle('bad space'), null);
  assert.equal(validPassword('short7!'), null);
  assert.equal(validPassword('strong-passphrase-12'), 'strong-passphrase-12');

  const { salt, hash } = await hashPassword('wardrobe-key-99');
  assert.equal(await verifyPassword('wardrobe-key-99', salt, hash), true);
  assert.equal(await verifyPassword('wrong-key-99', salt, hash), false);
  assert.equal(await verifyPassword('wardrobe-key-99', null, null), false);

  const header = formatAccountCookie('tok123', true);
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, /Secure/);
  assert.equal(readCookie(`foo=1; ${ACCT_COOKIE}=tok123; bar=2`), 'tok123');
});

function jacketPhotoBytes() {
  const w = 240, h = 320;
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = x >= 48 && x <= 192 && y >= 40 && y <= 270;
      data.set(inside ? [34, 48, 86, 255] : [236, 232, 224, 255], (y * w + x) * 4);
    }
  }
  const png = encodePng({ w, h, data });
  return { jpegBase64: jpeg.toString('base64'), pngBase64: png.toString('base64') };
}

test('AC-02 personal wardrobe upload, attribute correction, re-wear lock, claim, isolation, and re-login persistence', async () => {
  const srv = await startTempServer('flow');
  try {
    // 1. Guest opens a personal wardrobe, uploads their own jacket photo, corrects/confirms it, locks an outfit, and records wear.
    const created = await reqJson(srv.base, '/api/closet/personal', { body: {} });
    assert.equal(created.status, 200);
    const wsId = String(created.data.workspaceId);
    assert.match(wsId, /^my-/);

    const up = await reqJson(srv.base, `/api/ws/${wsId}/upload`, { body: jacketPhotoBytes() });
    assert.equal(up.status, 200);
    const photoId = String(up.data.photoId);
    assert.match(photoId, /^up_/);

    const photoOp = await reqJson(srv.base, `/api/ws/${wsId}/photo`, {
      body: { photoId, scan: false },
    });
    assert.equal(photoOp.status, 200);
    const opId = String(photoOp.data.operationId);
    const cards = photoOp.data.cards as Array<{ cardId: number; slot: string }>;
    assert.ok(cards.length >= 1, 'pixel segmentation detected the jacket');
    const card = cards[0];

    const v0 = await reqJson(srv.base, `/api/ws/${wsId}/view`);
    const confirmed = await reqJson(srv.base, `/api/ws/${wsId}/confirm`, {
      body: {
        operationId: opId,
        cardIds: [card.cardId],
        eventIds: ['ev-confirm-j1'],
        expectedRevision: v0.data.revision,
        answers: { [String(card.cardId)]: { type: 'jacket', color: 'navy', formality: 'high' } },
      },
    });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.data.ok, true);

    const anchorOp = await reqJson(srv.base, `/api/ws/${wsId}/anchor`, {
      body: { anchorItemIds: ['J1'], direction: 'less_formal' },
    });
    assert.equal(anchorOp.status, 200);
    assert.ok(Array.isArray(anchorOp.data.options) && (anchorOp.data.options as unknown[]).length >= 1);

    const v1 = await reqJson(srv.base, `/api/ws/${wsId}/view`);
    const locked = await reqJson(srv.base, `/api/ws/${wsId}/lock`, {
      body: { eventId: 'ev-lock-1', expectedRevision: v1.data.revision, operationId: anchorOp.data.operationId, optionIndex: 0 },
    });
    assert.equal(locked.status, 200);
    assert.equal(locked.data.ok, true);
    const planId = String((locked.data.result as { planId: string }).planId);

    const v2 = await reqJson(srv.base, `/api/ws/${wsId}/view`);
    const worn = await reqJson(srv.base, `/api/ws/${wsId}/wear`, {
      body: { eventId: 'ev-wear-1', expectedRevision: v2.data.revision, planId },
    });
    assert.equal(worn.status, 200);
    assert.equal(worn.data.ok, true);

    // 2. Claim the guest personal wardrobe by registering an account.
    const reg = await reqJson(srv.base, '/api/account/register', {
      body: { handle: 'owner@closer.invalid', password: 'jacket-again-password', claimWorkspaceId: wsId },
    });
    assert.equal(reg.status, 200);
    assert.equal(reg.data.signedIn, true);
    assert.equal(reg.data.workspaceId, wsId);
    const sessionCookie = cookiePair(reg.setCookie);
    assert.match(sessionCookie, /^closer_acct=[0-9a-f]{64}$/);

    // Duplicate handle is rejected (409), and unauthenticated access to the claimed wardrobe is now forbidden (403).
    const dup = await reqJson(srv.base, '/api/account/register', {
      body: { handle: 'owner@closer.invalid', password: 'another-password-123' },
    });
    assert.equal(dup.status, 409);

    const unauthView = await reqJson(srv.base, `/api/ws/${wsId}/view`);
    assert.equal(unauthView.status, 403);

    // 3. Logout clears session; wrong password fails; re-login restores exact wardrobe state.
    const out = await reqJson(srv.base, '/api/account/logout', { body: {}, cookie: sessionCookie });
    assert.equal(out.status, 200);
    const afterOut = await reqJson(srv.base, '/api/account', { cookie: sessionCookie });
    assert.equal(afterOut.data.signedIn, false);

    const badLogin = await reqJson(srv.base, '/api/account/login', {
      body: { handle: 'owner@closer.invalid', password: 'wrong-password-123' },
    });
    assert.equal(badLogin.status, 401);

    const login = await reqJson(srv.base, '/api/account/login', {
      body: { handle: 'owner@closer.invalid', password: 'jacket-again-password' },
    });
    assert.equal(login.status, 200);
    assert.equal(login.data.workspaceId, wsId);
    const freshCookie = cookiePair(login.setCookie);

    const restored = await reqJson(srv.base, `/api/ws/${wsId}/view`, { cookie: freshCookie });
    assert.equal(restored.status, 200);
    assert.equal((restored.data.workspace as { kind: string }).kind, 'real');
    const j1 = (restored.data.items as Array<{ itemId: string; wearCount: number }>).find((i) => i.itemId === 'J1');
    assert.ok(j1, 'confirmed jacket J1 persisted');
    assert.equal(j1.wearCount, 1, 'confirmed wear count persisted across logout/login');
  } finally {
    srv.stop();
  }
});
