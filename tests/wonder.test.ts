// Muse Wonder path: request builder, response reader, cost, mock port, the service gate and the link sorter.
// No network: every "live" case below uses a fake transport function, never adapters/transport.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.ts';
import { createMockPorts } from '../adapters/index.ts';
import { createPhotoLibrary } from '../fixtures/photos.ts';
import { textResponse } from '../adapters/mock/transport.ts';
import {
  buildWonderBody, createWonderPort, parseWonderResponse, wonderCostMicroUsd, wonderRequestFromJson,
  WEB_SEARCH_MICRO_USD, WONDER_EST_MICRO_USD, WONDER_MODEL,
} from '../adapters/wonder.ts';
import type { CallDeps } from '../adapters/responses.ts';
import { evidenceLinks, platformOfUrl } from '../engine/links.ts';
import { KILL_TTL_MS } from '../engine/caps.ts';

const deps = (transport: CallDeps['transport'], source: 'live' | 'mock' = 'live'): CallDeps => ({ transport, source, sleep: async () => {}, nowMs: () => 0, nowIso: () => '2026-11-04T14:00:00.000Z' });

/** A response in the shape the search-grounding and tool-calling docs describe. */
function searchReply(opts: { withResults?: boolean; usage?: boolean } = {}) {
  return {
    status: 200,
    headers: {},
    json: {
      id: 'resp_w_1', object: 'response', model: WONDER_MODEL, status: 'completed',
      output: [
        { id: 'ws_1', type: 'web_search_call', status: 'completed', ...(opts.withResults === false ? {} : { results: [
          { type: 'text_result', title: 'Beige coat · KREAM', url: 'https://kream.co.kr/products/123', snippet: 'listing' },
          { type: 'text_result', title: 'Coat listing', url: 'https://m.bunjang.co.kr/products/456', snippet: 'listing' },
          { type: 'text_result', title: 'Blog', url: 'http://example.com/not-https', snippet: 'skip' },
        ] }) },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Two listings were found.', annotations: [
          { type: 'url_citation', url: 'https://kream.co.kr/products/123', title: 'Beige coat · KREAM', start_index: 0, end_index: 12 },
          { type: 'url_citation', url: 'https://kream.co.kr/products/123', title: 'Beige coat · KREAM', start_index: 0, end_index: 12 },
          { type: 'url_citation', url: 'https://www.ebay.com/itm/789', title: 'eBay item', start_index: 13, end_index: 24 },
        ] }] },
      ],
      usage: opts.usage === false ? null : { input_tokens: 1000, output_tokens: 500, output_tokens_details: { reasoning_tokens: 100 } },
    },
  };
}

describe('W Muse Wonder: one general call, the same honesty as the rest', () => {
  it('W-01 the request follows the docs: model id, store false, images in the user message, strict schema, web_search + include, function tools, follow-up turn', () => {
    const b = buildWonderBody({ prompt: 'hello' });
    assert.equal(b.model, WONDER_MODEL);
    assert.equal(b.store, false);
    assert.deepEqual(b.reasoning, { effort: 'medium' });
    assert.equal(b.max_output_tokens, 2000);
    assert.equal('tools' in b, false);
    assert.equal('include' in b, false);
    const full = buildWonderBody({
      prompt: 'p', instructions: 'be brief', images: ['data:image/png;base64,AAAA'], schema: { name: 'wonder_x', schema: { type: 'object', properties: {}, required: [], additionalProperties: false } },
      tools: [{ name: 'lookup', description: 'd', parameters: { type: 'object', properties: {} } }], webSearch: { contextSize: 'low', userLocation: { country: 'KR' } },
      reasoning: 'high', maxOutputTokens: 99_999, previousResponseId: 'resp_prev', toolOutputs: [{ callId: 'call_1', output: 'ok' }], store: true, model: 'muse-spark-1.3',
    });
    assert.equal(full.model, 'muse-spark-1.3');
    assert.equal(full.store, true);
    assert.equal(full.max_output_tokens, 8000);
    const input = full.input as Record<string, unknown>[];
    assert.equal(input[0].role, 'system');
    const user = input[1] as { role: string; content: { type: string; image_url?: string }[] };
    assert.equal(user.role, 'user');
    assert.deepEqual(user.content.map((c) => c.type), ['input_text', 'input_image']);
    assert.deepEqual(input[2], { type: 'function_call_output', call_id: 'call_1', output: 'ok' });
    assert.deepEqual(full.tools, [
      { type: 'web_search', search_context_size: 'low', user_location: { type: 'approximate', country: 'KR' } },
      { type: 'function', name: 'lookup', description: 'd', parameters: { type: 'object', properties: {} }, strict: true },
    ]);
    assert.equal(full.parallel_tool_calls, false);
    assert.deepEqual(full.include, ['web_search_call.results']);
    assert.equal(full.previous_response_id, 'resp_prev');
    assert.deepEqual((full.text as { format: { type: string; strict: boolean; name: string } }).format.type, 'json_schema');
    assert.equal((full.text as { format: { strict: boolean } }).format.strict, true);
  });

  it('W-02 the reader keeps citations (deduplicated), the considered results, the search count, the text and the usage', () => {
    const v = parseWonderResponse(searchReply().json, false);
    assert.equal(v.responseId, 'resp_w_1');
    assert.equal(v.text, 'Two listings were found.');
    assert.equal(v.searchCalls, 1);
    assert.deepEqual(v.citations.map((c) => c.url), ['https://kream.co.kr/products/123', 'https://www.ebay.com/itm/789']);
    assert.equal(v.searchResults.length, 3);
    assert.deepEqual(v.usage, { inputTokens: 1000, outputTokens: 500, reasoningTokens: 100 });
    assert.equal(v.json, null);
    const fc = parseWonderResponse({ id: 'r', output: [{ type: 'function_call', call_id: 'call_9', name: 'lookup', arguments: '{"q":"coat"}', status: 'completed' }] }, false);
    assert.deepEqual(fc.functionCalls, [{ name: 'lookup', arguments: '{"q":"coat"}', callId: 'call_9' }]);
    const js = parseWonderResponse({ id: 'r', output: [{ type: 'message', content: [{ type: 'output_text', text: '```json\n{"a":1}\n```' }] }] }, true);
    assert.deepEqual(js.json, { a: 1 });
  });

  it('W-03 cost: the pricing page numbers, the estimate when usage is missing, search queries added on live calls only', async () => {
    assert.equal(wonderCostMicroUsd({ inputTokens: 1000, outputTokens: 500 }, 1), 1000 * 4 + 500 * 20);
    assert.equal(wonderCostMicroUsd(null, 777), 777);
    const livePort = createWonderPort(deps(async () => searchReply()));
    const r = await livePort.ask({ prompt: 'find listings', webSearch: true });
    assert.ok(r.ok);
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].model, WONDER_MODEL);
    assert.equal(r.calls[0].costMicroUsd, 14_000 + WEB_SEARCH_MICRO_USD);
    const noUsage = createWonderPort(deps(async () => searchReply({ usage: false })));
    const r2 = await noUsage.ask({ prompt: 'x', webSearch: true });
    assert.ok(r2.ok);
    assert.equal(r2.calls[0].costMicroUsd, WONDER_EST_MICRO_USD + WEB_SEARCH_MICRO_USD);
    const mockPort = createWonderPort(deps(async () => searchReply(), 'mock'));
    const r3 = await mockPort.ask({ prompt: 'x', webSearch: true });
    assert.ok(r3.ok);
    assert.equal(r3.calls[0].costMicroUsd, 0);
    assert.equal(r3.calls[0].estLiveCostMicroUsd, WONDER_EST_MICRO_USD);
  });

  it('W-04 a failed or empty answer is a HOLD with a reason, never a made-up text', async () => {
    const denied = createWonderPort(deps(async () => ({ status: 403, headers: {}, json: { error: { message: 'not available' } } })));
    const r = await denied.ask({ prompt: 'x' });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.http, 403);
      assert.equal(r.code, 'META_API_UNAVAILABLE');
      assert.match(r.detail, /check the key and whether the model is available/);
    }
    const empty = createWonderPort(deps(async () => ({ status: 200, headers: {}, json: { id: 'r', output: [] } })));
    const r2 = await empty.ask({ prompt: 'x' });
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.equal(r2.code, 'INVALID_MODEL_OUTPUT');
  });

  it('W-05 the mock transport answers Wonder requests with a line that says it is a mock, and takes a scripted reply', async () => {
    const lib = createPhotoLibrary();
    const { ports, transport } = createMockPorts(lib, { sleep: async () => {}, nowMs: () => 0, nowIso: () => 'now' });
    const r = await ports.wonder.ask({ prompt: 'what is in my closet?' });
    assert.ok(r.ok);
    assert.match(r.value.text ?? '', /^MOCK · Muse Wonder was not called/);
    assert.equal(r.calls[0].source, 'mock');
    assert.deepEqual(transport.log.map((l) => l.kind), ['wonder']);
    const scripted = createMockPorts(lib, { sleep: async () => {}, nowMs: () => 0, nowIso: () => 'now' }, { wonder: (n, body) => textResponse(String(body.model), `scripted ${n}`, 'wonder') });
    const s = await scripted.ports.wonder.ask({ prompt: 'x', model: 'muse-spark-1.3', webSearch: true });
    assert.ok(s.ok);
    assert.equal(s.value.text, 'scripted 0');
    // A Spark-model Wonder request without search or a wonder_ schema is indistinguishable from Spark 1 in mock mode, by design.
  });

  it('W-06 the service gate: caps and the kill switch apply, call rows are written, nothing touches the wardrobe, read-only is refused', async () => {
    const h = harness({ script: { wonder: (_n, body) => textResponse(String(body.model), 'answer', 'wonder') } });
    try {
      const before = h.hash();
      const r = await h.svc.askWonder(h.ws, { request: { prompt: 'Which coat should I look at first?' }, sessionId: 'sess-1' });
      assert.ok(r.ok, JSON.stringify(r));
      if (r.ok) {
        assert.equal(r.result.text, 'answer');
        assert.equal(r.mode, 'mock');
        assert.equal(r.callLines.length, 1);
        assert.match(r.callLines[0], /muse-wonder-1\.0 · 200/);
        assert.deepEqual(r.liveChips, []);
      }
      assert.equal(h.hash(), before);
      const rows = h.ledger.listCalls(10).filter((c) => c.model === WONDER_MODEL);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].operationId, null);
      assert.equal(rows[0].sessionId, 'sess-1');
      const blank = await h.svc.askWonder(h.ws, { request: { prompt: '   ' } });
      assert.equal(blank.ok, false);
      h.ledger.setFlag('kill', { on: true, setAt: h.clock.now.toISOString(), ttlMs: KILL_TTL_MS });
      const killed = await h.svc.askWonder(h.ws, { request: { prompt: 'x' } });
      assert.equal(killed.ok, false);
      if (!killed.ok) assert.equal(killed.code, 'META_DISABLED');
    } finally {
      h.cleanup();
    }
    const ro = harness({ publicReadOnly: true });
    try {
      const r = await ro.svc.askWonder(ro.ws, { request: { prompt: 'x' } });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, 'SCOPE_DENIED');
    } finally {
      ro.cleanup();
    }
  });

  it('W-07 a request from JSON is checked field by field', () => {
    assert.equal(wonderRequestFromJson({}), 'prompt is required');
    assert.match(String(wonderRequestFromJson({ prompt: 'x', reasoning: 'ultra' })), /reasoning must be one of/);
    assert.match(String(wonderRequestFromJson({ prompt: 'x', images: ['http://x/y.png'] })), /data:image/);
    assert.match(String(wonderRequestFromJson({ prompt: 'x', model: 'muse-wonder-9' })), /model must be one of/);
    assert.match(String(wonderRequestFromJson({ prompt: 'x', tools: [{ name: 'browser.search', parameters: {} }] })), /reserved/);
    assert.match(String(wonderRequestFromJson({ prompt: 'x', maxOutputTokens: 1 })), /maxOutputTokens/);
    assert.match(String(wonderRequestFromJson({ prompt: 'a'.repeat(4001) })), /at most 4000/);
    const ok = wonderRequestFromJson({ prompt: 'x', webSearch: { contextSize: 'high', userLocation: { country: 'KR', city: 'Seoul' } }, reasoning: 'low', maxOutputTokens: 500, store: true });
    assert.ok(typeof ok !== 'string');
    if (typeof ok !== 'string') assert.deepEqual(ok.webSearch, { contextSize: 'high', userLocation: { country: 'KR', city: 'Seoul' } });
  });

  it('W-08 links are sorted by platform from the host, https only, cited ones first, one row per url, no price read from any page', () => {
    assert.deepEqual(platformOfUrl('https://kream.co.kr/products/1'), { host: 'kream.co.kr', platform: 'KREAM' });
    assert.equal(platformOfUrl('https://www.daangn.com/articles/1')!.platform, 'KARROT');
    assert.equal(platformOfUrl('https://m.bunjang.co.kr/products/2')!.platform, 'BUNJANG');
    assert.equal(platformOfUrl('https://poshmark.com/listing/3')!.platform, 'POSHMARK');
    assert.equal(platformOfUrl('https://www.ebay.co.uk/itm/4')!.platform, 'EBAY');
    assert.equal(platformOfUrl('https://www.grailed.com/listings/5')!.platform, 'GRAILED');
    assert.equal(platformOfUrl('https://www.depop.com/products/6')!.platform, 'DEPOP');
    assert.equal(platformOfUrl('https://www.vinted.fr/items/7')!.platform, 'VINTED');
    assert.equal(platformOfUrl('https://example.com/x')!.platform, 'OTHER');
    assert.equal(platformOfUrl('http://kream.co.kr/x'), null);
    assert.equal(platformOfUrl('not a url'), null);
    const links = evidenceLinks(parseWonderResponse(searchReply().json, false));
    assert.deepEqual(links.map((l) => [l.platform, l.cited]), [['KREAM', true], ['EBAY', true], ['BUNJANG', false]]);
    assert.equal(links.some((l) => 'price' in l || 'amount' in l), false);
  });
});
