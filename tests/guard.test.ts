// Request guards of the web server (web/guard.ts): rate limiter, address resolution, token
// comparison, strict JSON bodies and the response headers. No server is started here.
import './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { BadRequest, CSP, RateLimiter, SECURITY_HEADERS, clientIp, readJson, tokenMatches } from '../web/guard.ts';

test('GD-01 rate limiter: a burst of `limit`, then one token per window/limit, forgotten once full again', () => {
  const rl = new RateLimiter(3, 3000);
  const t0 = 1_000_000;
  assert.equal(rl.take('a', t0), null);
  assert.equal(rl.take('a', t0), null);
  assert.equal(rl.take('a', t0), null);
  const wait = rl.take('a', t0);
  assert.ok(wait !== null && wait > 0 && wait <= 1000, `fourth request waits for the next token (${wait} ms)`);
  assert.equal(rl.take('b', t0), null, 'another address has its own bucket');
  assert.notEqual(rl.take('a', t0 + 999), null, 'not yet: 0.999 of a token');
  assert.equal(rl.take('a', t0 + 1000), null, 'one token refilled after window/limit');
  assert.notEqual(rl.take('a', t0 + 1000), null);
  assert.equal(rl.take('a', t0 + 1000 + 3000), null, 'full again after a whole window');
  rl.prune(t0 + 20_000);
  assert.equal(rl.size, 0, 'full buckets are dropped');
});

test('GD-02 client address: socket by default; the last X-Forwarded-For entry only when the proxy is trusted', () => {
  const req = { headers: { 'x-forwarded-for': '203.0.113.9, 198.51.100.4' }, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage;
  assert.equal(clientIp(req, false), '127.0.0.1');
  assert.equal(clientIp(req, true), '198.51.100.4');
  const bare = { headers: {}, socket: { remoteAddress: '10.0.0.2' } } as unknown as IncomingMessage;
  assert.equal(clientIp(bare, true), '10.0.0.2', 'no header: the socket address even when the proxy is trusted');
});

test('GD-03 token check: equal strings only; missing, empty or different-length values never match', () => {
  assert.equal(tokenMatches('abc123', 'abc123'), true);
  assert.equal(tokenMatches('abc124', 'abc123'), false);
  assert.equal(tokenMatches('abc12', 'abc123'), false);
  assert.equal(tokenMatches(undefined, 'abc123'), false);
  assert.equal(tokenMatches(['abc123'], 'abc123'), false);
  assert.equal(tokenMatches('', ''), false);
  assert.equal(tokenMatches('x', undefined), false);
});

function fakePost(body: string | null, contentType: string | null): IncomingMessage {
  const r = Readable.from(body === null ? [] : [Buffer.from(body, 'utf8')]) as unknown as IncomingMessage;
  (r as { headers: Record<string, string> }).headers = contentType === null ? {} : { 'content-type': contentType };
  return r;
}

test('GD-04 JSON bodies: application/json only, an object only, size-limited, parser text never echoed', async () => {
  assert.deepEqual(await readJson(fakePost('{"a":1}', 'application/json')), { a: 1 });
  assert.deepEqual(await readJson(fakePost('{"a":1}', 'application/json; charset=utf-8')), { a: 1 });
  assert.deepEqual(await readJson(fakePost(null, 'application/json')), {}, 'an empty body is an empty object');
  await assert.rejects(readJson(fakePost('{"a":1}', 'text/plain')), (e: unknown) => e instanceof BadRequest && e.status === 415);
  await assert.rejects(readJson(fakePost('{"a":1}', null)), (e: unknown) => e instanceof BadRequest && e.status === 415);
  await assert.rejects(readJson(fakePost('{"a":', 'application/json')), (e: unknown) => e instanceof BadRequest && e.status === 400 && e.message === 'invalid JSON');
  await assert.rejects(readJson(fakePost('[1,2]', 'application/json')), (e: unknown) => e instanceof BadRequest && e.status === 400);
  await assert.rejects(readJson(fakePost('null', 'application/json')), (e: unknown) => e instanceof BadRequest && e.status === 400);
  await assert.rejects(readJson(fakePost('{"a":"xxxxxxxxxx"}', 'application/json'), 8), (e: unknown) => e instanceof BadRequest && e.status === 413);
});

test('GD-05 response headers: a policy without unsafe-inline or unsafe-eval, nosniff, no referrer, no framing', () => {
  assert.ok(!/unsafe-(inline|eval)/.test(CSP));
  assert.ok(CSP.includes("script-src 'self'"));
  assert.ok(CSP.includes("img-src 'self' data: blob:"));
  assert.ok(CSP.includes("frame-ancestors 'none'"));
  assert.equal(SECURITY_HEADERS['Content-Security-Policy'], CSP);
  assert.equal(SECURITY_HEADERS['X-Content-Type-Options'], 'nosniff');
  assert.equal(SECURITY_HEADERS['Referrer-Policy'], 'no-referrer');
  assert.match(SECURITY_HEADERS['Permissions-Policy'], /camera=\(self\)/);
});
