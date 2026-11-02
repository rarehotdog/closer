// 미검증 — 문서 예시 기반, 실호출 0
// Spark 2: one function-tool turn inside the candidates code passed: propose_edit (≤2 options) or
// ask_owner. parallel_tool_calls:false, tool_choice not sent (only "auto" is supported), store:false.
// Arguments are re-checked by code (engine/validate.ts). A text reply is NO_ACTION.
import { SLOTS } from '../shared/wardrobe.ts';
import { statusToReason } from '../engine/retry.ts';
import { ASK_CODES } from '../engine/validate.ts';
import { callResponses, EST_MICRO_USD, functionCalls, outputText, SPARK_MODEL, sparkCostMicroUsd, type CallDeps } from './responses.ts';
import type { Spark2Port, Spark2Request } from './types.ts';

export const PROPOSE_EDIT_TOOL = {
  type: 'function',
  name: 'propose_edit',
  description: 'Propose at most two edits. Use only candidate item IDs given per slot.',
  strict: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['options'],
    properties: {
      options: {
        type: 'array',
        minItems: 1,
        maxItems: 2,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['changes', 'reasonFactIds', 'visual_match'],
          properties: {
            changes: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['slot', 'itemId'],
                properties: { slot: { type: 'string', enum: [...SLOTS] }, itemId: { type: 'string' } },
              },
            },
            reasonFactIds: { type: 'array', items: { type: 'string' } },
            visual_match: {
              type: 'array',
              items: { type: 'object', additionalProperties: false, required: ['itemId'], properties: { itemId: { type: 'string' } } },
            },
          },
        },
      },
    },
  },
} as const;

export const ASK_OWNER_TOOL = {
  type: 'function',
  name: 'ask_owner',
  description: 'Ask the owner one question instead of guessing.',
  strict: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['questionCode', 'itemIds'],
    properties: {
      questionCode: { type: 'string', enum: [...ASK_CODES] },
      itemIds: { type: 'array', items: { type: 'string' } },
    },
  },
} as const;

export const SPARK2_INSTRUCTIONS = [
  'You help the owner of these clothes edit one outfit. Call exactly one tool.',
  'propose_edit: at most two options using only the candidate item IDs listed per slot.',
  'Option 1 changes as few items as possible. Option 2 is closer to what the owner said, with at most two changes.',
  'Keep pinned items. Change only flagged slots; if none are flagged, any unpinned slot.',
  'Cite reasons only with IDs from factIds.',
  'If the request is ambiguous or nothing fits, call ask_owner instead of guessing.',
].join('\n');

export function buildSpark2Body(req: Spark2Request): Record<string, unknown> {
  const payload = { ...req.facts, correction: req.correction };
  return {
    model: SPARK_MODEL,
    store: false,
    reasoning: { effort: 'low' },
    max_output_tokens: 4000,
    parallel_tool_calls: false,
    tools: [PROPOSE_EDIT_TOOL, ASK_OWNER_TOOL],
    input: [
      { type: 'message', role: 'system', content: [{ type: 'input_text', text: SPARK2_INSTRUCTIONS }] },
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: JSON.stringify(payload) },
          ...req.thumbnails.map((t) => ({ type: 'input_image', image_url: t.imageUrl })),
        ],
      },
    ],
  };
}

export function createSpark2Port(deps: CallDeps): Spark2Port {
  return {
    async propose(req) {
      const { outcome, calls } = await callResponses(deps, buildSpark2Body(req), {
        model: SPARK_MODEL,
        estMicroUsd: EST_MICRO_USD.spark2,
        price: (u) => sparkCostMicroUsd(u, EST_MICRO_USD.spark2),
      });
      const f = outcome.final;
      if (!f || f.status < 200 || f.status >= 300) {
        const status = f?.status ?? 0;
        return { ok: false, http: status, code: statusToReason(status), detail: `Spark 2 HTTP ${status}`, calls };
      }
      const fc = functionCalls(f.json);
      if (fc.length > 1) return { ok: false, http: f.status, code: 'INVALID_MODEL_OUTPUT', detail: 'more than one tool call', calls };
      if (fc.length === 1) return { ok: true, value: { kind: 'function_call', name: fc[0].name, arguments: fc[0].arguments }, calls };
      return { ok: true, value: { kind: 'text', text: outputText(f.json) ?? '' }, calls };
    },
  };
}
