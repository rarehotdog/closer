// Response parsing for live calls (adapters/responses.ts). Synthetic JSON only, no network.
// The live response shape is still unconfirmed (one live run on 2026-11-05, docs/live/live_check.json; other shapes are from the docs), so these pin what each fallback does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { functionCalls, outputText, parseJsonOutput, readUsage, sparkCostMicroUsd } from '../adapters/responses.ts';

test('RP-01 readUsage reads Responses, Chat and camelCase names without adding them up', () => {
  assert.deepEqual(readUsage({ usage: { input_tokens: 10, output_tokens: 20, output_tokens_details: { reasoning_tokens: 5 } } }), { inputTokens: 10, outputTokens: 20, reasoningTokens: 5 });
  assert.deepEqual(readUsage({ usage: { prompt_tokens: 7, completion_tokens: 3, completion_tokens_details: { reasoning_tokens: 1 } } }), { inputTokens: 7, outputTokens: 3, reasoningTokens: 1 });
  assert.deepEqual(readUsage({ usage: { inputTokens: 4, outputTokens: 2 } }), { inputTokens: 4, outputTokens: 2, reasoningTokens: 0 });
  // Both names present: the Responses name wins; nothing is summed.
  assert.deepEqual(readUsage({ usage: { input_tokens: 10, prompt_tokens: 99, output_tokens: 20, completion_tokens: 99 } }), { inputTokens: 10, outputTokens: 20, reasoningTokens: 0 });
});

test('RP-02 usage with no token counts is unknown and is charged at the estimate, not zero', () => {
  assert.equal(readUsage({}), null);
  assert.equal(readUsage({ usage: null }), null);
  assert.equal(readUsage({ usage: { total_tokens: 1234 } }), null);
  assert.equal(sparkCostMicroUsd(readUsage({ usage: { total_tokens: 1234 } }), 15_000), 15_000);
  assert.equal(sparkCostMicroUsd(readUsage({ usage: { input_tokens: 'n/a', output_tokens: 3 } }), 15_000), 15_000);
  assert.equal(sparkCostMicroUsd(readUsage({ usage: { input_tokens: 1000, output_tokens: 1000 } }), 15_000), 5_500);
});

test('RP-03 outputText: message parts first, then top-level output_text, then choices', () => {
  const msg = { output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: '{"a":' }, { type: 'output_text', text: '1}' }] }] };
  assert.equal(outputText(msg), '{"a":1}');
  assert.equal(outputText({ output: [{ type: 'output_text', text: 'x' }] }), 'x');
  assert.equal(outputText({ output: [{ type: 'reasoning' }], output_text: 'y' }), 'y');
  assert.equal(outputText({ choices: [{ message: { content: 'z' } }] }), 'z');
  assert.equal(outputText({ output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }), null);
  assert.equal(outputText({ output_text: '' }), null);
  assert.equal(outputText(null), null);
});

test('RP-04 parseJsonOutput accepts plain JSON or one fenced block, and nothing else', () => {
  assert.deepEqual(parseJsonOutput(' {"keep":["J1"]} '), { keep: ['J1'] });
  assert.deepEqual(parseJsonOutput('```json\n{"keep":[]}\n```'), { keep: [] });
  assert.deepEqual(parseJsonOutput('```\n[1,2]\n```'), [1, 2]);
  assert.throws(() => parseJsonOutput('Sure! {"keep":[]}'));
  assert.throws(() => parseJsonOutput('```json\n{"keep":[]}\n``` and more'));
});

test('RP-05 functionCalls: Responses items, object arguments, Chat tool_calls', () => {
  assert.deepEqual(functionCalls({ output: [{ type: 'function_call', name: 'f', arguments: '{"x":1}', call_id: 'call_1', id: 'fc_1' }] }), [{ name: 'f', arguments: '{"x":1}', callId: 'call_1' }]);
  assert.deepEqual(functionCalls({ output: [{ type: 'function_call', name: 'f', arguments: { x: 1 }, id: 'fc_2' }] }), [{ name: 'f', arguments: '{"x":1}', callId: 'fc_2' }]);
  assert.deepEqual(functionCalls({ choices: [{ message: { tool_calls: [{ id: 't1', function: { name: 'g', arguments: '{}' } }] } }] }), [{ name: 'g', arguments: '{}', callId: 't1' }]);
  assert.deepEqual(functionCalls({ output: [{ type: 'message', content: [] }] }), []);
  assert.deepEqual(functionCalls(null), []);
});
