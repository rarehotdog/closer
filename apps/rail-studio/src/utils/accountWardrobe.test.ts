import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountWardrobeController, isPersonalPiece, localPieces } from './accountWardrobe';
import { INITIAL_GARMENTS } from '../data/seedCloset';
import type { GarmentPiece } from '../types/closet';

const own = (id = 'piece-custom-one'): GarmentPiece => ({ ...structuredClone(INITIAL_GARMENTS[0]), id, code: 'A11', isSample: false,
  observations: [], wearsLast60Days: 0, wearLogStatus: 'insufficient', imageUrl: undefined,
  frontImageUrl: undefined, lastDecision: undefined, scanMode: undefined });
const response = (data: any, status = 200) => new Response(JSON.stringify({ ...(typeof data.revision === 'number' ? {ledgerRevision: data.revision, ledgerStatus: 'verified', ledgerWarnings: []} : {}), ...data }), { status, headers: { 'Content-Type': 'application/json' } });
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  let who: string | null = null;
  const docs = new Map<string, { revision: number; pieces: GarmentPiece[] }>([['a', { revision: 0, pieces: [] }], ['b', { revision: 0, pieces: [] }]]);
  const writes: any[] = [];
  let put: ((body: any) => Promise<Response>) | null = null;
  const request = async (url: string, init?: RequestInit): Promise<Response> => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.endsWith('/register') || url.endsWith('/login')) { who = body.handle; return response({ ok: true, signedIn: true, handle: who, workspaceId: who }); }
    if (url.endsWith('/logout')) { who = null; return response({ ok: true, signedIn: false }); }
    if (url === '/api/account') return response({ ok: true, signedIn: !!who, handle: who, workspaceId: who });
    if (!who) return response({ ok: false, detail: 'Sign in again.' }, 401);
    if (init?.method === 'PUT') {
      writes.push(body);
      if (put) return put(body);
      if (body.workspaceId !== who) return response({ ok: false }, 403);
      const doc = docs.get(who)!;
      if (body.expectedRevision !== doc.revision) return response({ ok: false, detail: 'Newer version exists.' }, 409);
      docs.set(who, { revision: doc.revision + 1, pieces: body.pieces });
    }
    return response({ ok: true, workspaceId: who, ...docs.get(who)! });
  };
  const persisted: GarmentPiece[][] = [];
  const ctl = new AccountWardrobeController(request, INITIAL_GARMENTS, [own()], pieces => { persisted.push(pieces); });
  return { ctl, docs, writes, persisted, switchTo: (id: string | null) => { who = id; }, onPut: (fn: typeof put) => { put = fn; } };
}

test('all built-in fixtures and fake scans stay out of personal imports', () => {
  assert(INITIAL_GARMENTS.every(piece => !isPersonalPiece(piece)));
  assert.equal(isPersonalPiece({ ...own('scan-test'), scanMode: 'fake' }), false);
  assert.equal(isPersonalPiece({ ...own(), isSample: true }), false);
  assert.equal(isPersonalPiece({ ...own(), observations: [{ id: 'one', date: '2026-11-05', platform: 'KREAM', price: 1, currency: 'KRW', kind: 'listed', isSample: true }] }), false);
  assert.equal(isPersonalPiece(own()), true);
  assert.equal(isPersonalPiece({ ...own('scan-real-J1'), code: 'J1' }), true);
  assert.equal(localPieces([...INITIAL_GARMENTS, own()]).length, 1);
});

test('login hydrates records without an automatic save or guest import; logout does not persist private records locally', async () => {
  const f = fixture(); f.docs.set('a', { revision: 4, pieces: [own('piece-custom-private')] });
  await f.ctl.authenticate('login', 'a', 'password');
  assert.equal(f.ctl.getSnapshot().pieces[0].id, 'piece-custom-private');
  assert.equal(f.writes.length, 0); assert.equal(f.persisted.length, 0);
  await f.ctl.logout();
  assert.equal(f.ctl.getSnapshot().account, null);
  assert(!f.ctl.getSnapshot().pieces.some(p => p.id === 'piece-custom-private'));
  assert.equal(f.persisted.length, 0);
});

test('explicit import excludes demo records and account changes save only after readback', async () => {
  const f = fixture(); await f.ctl.authenticate('register', 'a', 'password');
  assert.deepEqual(f.ctl.getSnapshot().pieces, []);
  const gate = deferred<Response>(); f.onPut(() => gate.promise);
  f.ctl.importLocal(); await tick();
  assert.equal(f.ctl.getSnapshot().status, 'saving');
  assert.equal(f.writes[0].pieces.length, 1);
  assert.equal(f.writes[0].pieces[0].id, 'piece-custom-one');
  gate.resolve(response({ ok: true, workspaceId: 'a', revision: 1, pieces: f.writes[0].pieces }));
  await f.ctl.flush(); assert.equal(f.ctl.getSnapshot().status, 'saved');
  assert.equal(f.persisted.length, 0);
});

test('rapid edits serialize against the last acknowledged revision', async () => {
  const f = fixture(); await f.ctl.authenticate('login', 'a', 'password');
  const gate = deferred<Response>(); let n = 0;
  f.onPut(async body => { if (n++ === 0) return gate.promise; return response({ ok: true, workspaceId: 'a', revision: 2, pieces: body.pieces }); });
  f.ctl.update([own()]); f.ctl.update([ { ...own(), name: 'Second edit' } ]);
  assert.equal(f.writes.length, 1);
  gate.resolve(response({ ok: true, workspaceId: 'a', revision: 1, pieces: [own()] }));
  await f.ctl.flush();
  assert.deepEqual(f.writes.map(w => w.expectedRevision), [0, 1]);
  assert.equal(f.ctl.getSnapshot().pieces[0].name, 'Second edit');
  assert.equal(f.ctl.getSnapshot().status, 'saved');
});

test('failed save stays unsaved, blocks logout and retries the same revision', async () => {
  const f = fixture(); await f.ctl.authenticate('login', 'a', 'password');
  f.onPut(async () => { throw new Error('Offline'); });
  f.ctl.update([own()]); await tick();
  assert.equal(f.ctl.getSnapshot().status, 'error');
  await assert.rejects(f.ctl.logout(), /Offline/);
  assert.equal(f.ctl.getSnapshot().account?.workspaceId, 'a');
  f.onPut(null); await f.ctl.retry();
  assert.equal(f.ctl.getSnapshot().status, 'saved');
  assert.deepEqual(f.writes.map(w => w.expectedRevision), [0, 0]);
});

test('revision conflicts never auto-overwrite and need an explicit saved-version reload', async () => {
  const f = fixture(); await f.ctl.authenticate('login', 'a', 'password');
  f.docs.set('a', { revision: 1, pieces: [{ ...own(), name: 'Other tab' }] });
  f.ctl.update([own()]); await tick();
  assert.equal(f.ctl.getSnapshot().status, 'conflict');
  await f.ctl.retry(); await assert.rejects(f.ctl.logout());
  assert.equal(f.writes.length, 1);
  await f.ctl.reload();
  assert.equal(f.ctl.getSnapshot().pieces[0].name, 'Other tab');
  assert.equal(f.ctl.getSnapshot().revision, 1);
});

test('late writes from account A cannot overwrite account B or its revision', async () => {
  const f = fixture(); await f.ctl.authenticate('login', 'a', 'password');
  const gate = deferred<Response>(); f.onPut(() => gate.promise);
  f.ctl.update([own('piece-custom-a')]);
  f.switchTo('b'); await f.ctl.checkSession();
  assert.equal(f.ctl.getSnapshot().account?.workspaceId, 'b');
  gate.resolve(response({ ok: true, workspaceId: 'a', revision: 1, pieces: [own('piece-custom-a')] }));
  await tick(); assert.deepEqual(f.ctl.getSnapshot().pieces, []); assert.equal(f.ctl.getSnapshot().revision, 0);
  f.onPut(null); f.ctl.update([own('piece-custom-b')]); await f.ctl.flush();
  assert.equal(f.docs.get('b')!.pieces[0].id, 'piece-custom-b');
  assert.equal(f.persisted.length, 0);
});

test('expired sessions clear private records; sample edits never enter the save queue', async () => {
  const f = fixture(); await f.ctl.authenticate('login', 'a', 'password');
  await f.ctl.toggleSample(); f.ctl.update(p => p.map(g => ({ ...g, name: 'Demo edit' })));
  assert.equal(f.writes.length, 0); await f.ctl.toggleSample();
  assert.deepEqual(f.ctl.getSnapshot().pieces, []);
  f.switchTo(null); f.ctl.update([own('piece-custom-private')]); await tick();
  assert.equal(f.ctl.getSnapshot().account, null);
  assert(!f.ctl.getSnapshot().pieces.some(p => p.id === 'piece-custom-private'));
});


test('account B edits made before old account A responds still drain with B revision', async () => {
  const f = fixture(); await f.ctl.authenticate('login', 'a', 'password');
  const gate = deferred<Response>(); f.onPut(body => body.workspaceId === 'a' ? gate.promise : Promise.resolve(response({ ok: true, workspaceId: 'b', revision: 1, pieces: body.pieces })));
  f.ctl.update([own('piece-custom-a')]);
  f.switchTo('b'); await f.ctl.checkSession();
  f.ctl.update([own('piece-custom-b')]);
  assert.equal(f.writes.length, 1);
  const flush = f.ctl.flush();
  gate.resolve(response({ ok: true, workspaceId: 'a', revision: 1, pieces: [own('piece-custom-a')] }));
  await flush;
  assert.deepEqual(f.writes.map(w => [w.workspaceId, w.expectedRevision]), [['a', 0], ['b', 0]]);
  assert.equal(f.ctl.getSnapshot().status, 'saved');
  assert.equal(f.ctl.getSnapshot().pieces[0].id, 'piece-custom-b');
});

test('authentication cannot discard a failed pending save', async () => {
  const f = fixture(); await f.ctl.authenticate('login', 'a', 'password');
  f.onPut(async () => { throw new Error('Offline'); });
  f.ctl.update([own()]); await tick();
  await assert.rejects(f.ctl.authenticate('login', 'b', 'password'), /Offline/);
  assert.equal(f.ctl.getSnapshot().account?.workspaceId, 'a');
});


for (const failureStatus of [401, 403, 500]) test(`late hydration failure ${failureStatus} cannot clear or mark a newer account failed`, async () => {
  let who = 'a';
  const gate = deferred<Response>();
  const request = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.endsWith('/login')) {
      who = JSON.parse(String(init?.body)).handle;
      return response({ ok: true, signedIn: true, handle: who, workspaceId: who });
    }
    if (url === '/api/account') return response({ ok: true, signedIn: true, handle: who, workspaceId: who });
    if (who === 'b') return gate.promise;
    return response({ ok: true, workspaceId: who, revision: 2, pieces: [own(`piece-custom-${who}`)] });
  };
  const ctl = new AccountWardrobeController(request, INITIAL_GARMENTS, []);
  await ctl.authenticate('login', 'a', 'password');
  who = 'b'; const checking = ctl.checkSession(); await tick();
  assert.equal(ctl.getSnapshot().account?.workspaceId, 'b');
  await ctl.authenticate('login', 'c', 'password');
  gate.resolve(response({ ok: false, detail: 'Old request failed.' }, failureStatus));
  await checking;
  assert.equal(ctl.getSnapshot().account?.workspaceId, 'c');
  assert.equal(ctl.getSnapshot().pieces[0].id, 'piece-custom-c');
  assert.equal(ctl.getSnapshot().status, 'saved');
  assert.equal(ctl.getSnapshot().error, null);
  assert.equal(ctl.getSnapshot().busy, false);
});


test('lost save response replays the identical request before a later edit', async () => {
  const f = fixture(); await f.ctl.authenticate('login', 'a', 'password');
  const committed = new Map<string, object>(); let calls = 0;
  f.onPut(async body => {
    if (committed.has(body.requestId)) return response(committed.get(body.requestId)!);
    const saved = {ok: true, workspaceId: 'a', revision: body.expectedRevision + 1,
      ledgerRevision: body.expectedLedgerRevision + 2, pieces: structuredClone(body.pieces)};
    committed.set(body.requestId, saved);
    if (calls++ === 0) throw new Error('Response lost after commit');
    return response(saved);
  });
  f.ctl.update([own()]); await tick();
  assert.equal(f.ctl.getSnapshot().status, 'error');
  f.ctl.update([{ ...own(), name: 'Newer local edit' }]);
  await f.ctl.retry();
  assert.equal(f.writes.length, 3);
  assert.deepEqual(f.writes[0], f.writes[1]);
  assert.notEqual(f.writes[1].requestId, f.writes[2].requestId);
  assert.equal(f.writes[2].expectedLedgerRevision, 2);
  assert.equal(f.ctl.getSnapshot().ledgerRevision, 4);
  assert.equal(f.ctl.getSnapshot().pieces[0].name, 'Newer local edit');
  assert.equal(committed.size, 2);
});

test('a snapshot-only response cannot be displayed as a verified ledger save', async () => {
  const f = fixture(); await f.ctl.authenticate('login', 'a', 'password');
  f.onPut(async body => new Response(JSON.stringify({ok:true,workspaceId:'a',revision:1,pieces:body.pieces})));
  f.ctl.update([own()]); await tick();
  assert.equal(f.ctl.getSnapshot().status, 'error');
  assert.equal(f.ctl.getSnapshot().revision, 0);
});

test('partial ledger projections retain the warning for the owner', async () => {
  const f = fixture(); await f.ctl.authenticate('login', 'a', 'password');
  f.onPut(async body => response({ok:true,workspaceId:'a',revision:1,ledgerRevision:3,
    ledgerStatus:'partial',ledgerWarnings:['A platform currency needs review.'],pieces:body.pieces}));
  f.ctl.update([own()]); await f.ctl.flush();
  assert.equal(f.ctl.getSnapshot().ledgerStatus, 'partial');
  assert.deepEqual(f.ctl.getSnapshot().ledgerWarnings, ['A platform currency needs review.']);
});


test('a rejected photo can be corrected without replaying the invalid save forever', async () => {
  const f=fixture(); await f.ctl.authenticate('login','a','password');
  f.onPut(async () => response({ok:false,detail:'This photo has no matching receipt.'},400));
  f.ctl.update([own('scan-invalid')]); await tick();
  assert.equal(f.ctl.getSnapshot().status,'error');
  f.ctl.update([own('piece-custom-corrected')]);
  f.onPut(null); await f.ctl.retry();
  assert.equal(f.ctl.getSnapshot().status,'saved');
  assert.notEqual(f.writes[0].requestId,f.writes[1].requestId);
  assert.equal(f.writes[1].pieces[0].id,'piece-custom-corrected');
});
