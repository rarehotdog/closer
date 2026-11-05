// The scan route as the browser sees it: modes, refusals and limits, over real HTTP on a free port.
// No network beyond localhost: the key is removed, and the fake is switched on only where a test says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

process.env.CLOSER_NO_LISTEN = '1';
delete process.env.MODEL_API_KEY;
delete process.env.META_API_KEY;
delete process.env.CLOSER_KILL;
delete process.env.CLOSER_SCAN_FAKE;
const { createApp, scanMode } = await import('../server.ts');

const dir = join(import.meta.dirname, 'test', 'fixtures');
const body = JSON.stringify({
  jpegBase64: readFileSync(join(dir, 'outfit.jpg')).toString('base64'),
  pngBase64: readFileSync(join(dir, 'outfit.png')).toString('base64'),
  sentence: '',
});

async function withServer(fn: (base: string) => Promise<void>) {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}
const post = (base: string, b: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/scan`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: b });

test('RT-01 no key: status says no_key and a scan is refused with 503 before any call', async () => {
  assert.equal(scanMode(), 'no_key');
  await withServer(async (base) => {
    const s = await (await fetch(`${base}/api/scan/status`)).json();
    assert.equal(s.mode, 'no_key');
    assert.equal('key' in s, false);
    const r = await post(base, body);
    assert.equal(r.status, 503);
    const j = await r.json();
    assert.equal(j.code, 'META_KEY_MISSING');
  });
});

test('RT-02 the status never carries the key, even when one is set', async () => {
  process.env.MODEL_API_KEY = 'test-value-not-a-real-key';
  try {
    assert.equal(scanMode(), 'live');
    await withServer(async (base) => {
      const text = await (await fetch(`${base}/api/scan/status`)).text();
      assert.equal(text.includes('test-value-not-a-real-key'), false);
      assert.equal(JSON.parse(text).mode, 'live');
    });
  } finally {
    delete process.env.MODEL_API_KEY;
  }
});

test('RT-03 kill switch wins over a key and over the fake', async () => {
  process.env.CLOSER_KILL = '1';
  process.env.CLOSER_SCAN_FAKE = '1';
  try {
    await withServer(async (base) => {
      const r = await post(base, body);
      assert.equal(r.status, 503);
      assert.equal((await r.json()).code, 'META_DISABLED');
    });
  } finally {
    delete process.env.CLOSER_KILL;
    delete process.env.CLOSER_SCAN_FAKE;
  }
});

test('RT-04 test fake: cards come back labelled fake; bad input is a 400; a body over 16 MB is refused', async () => {
  process.env.CLOSER_SCAN_FAKE = '1';
  try {
    await withServer(async (base) => {
      const ok = await post(base, body);
      assert.equal(ok.status, 200);
      const j = await ok.json();
      assert.equal(j.mode, 'fake');
      assert.equal(j.cards.length, 2);
      assert.ok(j.calls.every((c: { source: string }) => c.source === 'mock'));
      const bad = await post(base, JSON.stringify({ jpegBase64: 'not base64 !', pngBase64: 'x', sentence: '' }));
      assert.equal(bad.status, 400);
      const big = await post(base, JSON.stringify({ jpegBase64: 'A'.repeat(17 * 1024 * 1024), pngBase64: '', sentence: '' }));
      assert.equal(big.status, 413);
      assert.equal((await big.json()).code, 'BAD_INPUT');
      const notJson = await post(base, '{not json');
      assert.equal(notJson.status, 400);
    });
  } finally {
    delete process.env.CLOSER_SCAN_FAKE;
  }
});

test('RT-05 rate limit: the 21st scan from one address within 10 minutes gets 429', async () => {
  process.env.CLOSER_SCAN_FAKE = '1';
  try {
    await withServer(async (base) => {
      // Earlier tests in this file already used some of this address's budget; count until refused.
      let refusedAt = 0;
      for (let i = 1; i <= 25; i++) {
        const r = await post(base, body);
        if (r.status === 429) {
          refusedAt = i;
          assert.equal((await r.json()).code, 'CALL_CAP_REACHED');
          break;
        }
        await r.arrayBuffer();
      }
      assert.ok(refusedAt > 0 && refusedAt <= 21, `refused at ${refusedAt}`);
    });
  } finally {
    delete process.env.CLOSER_SCAN_FAKE;
  }
});
