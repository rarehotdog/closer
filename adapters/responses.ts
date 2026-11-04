// 미검증 — 문서 예시 기반, 실호출 0
// Shared Responses-API plumbing: send with the retry policy, turn every HTTP attempt into a call
// row, read output text / function calls, and price usage.
import { randomUUID } from 'node:crypto';
import type { CallSource } from '../shared/ledger.ts';
import type { ReasonCode } from '../shared/reasons.ts';
import { sendWithRetry, statusToReason, type HttpResult, type RetryOutcome } from '../engine/retry.ts';
import type { Transport } from './transport.ts';
import type { CallDraft } from './types.ts';

export const SPARK_MODEL = 'muse-spark-1.3';
export const SAM_MODEL = 'sam-3.1';

/** Plan §3-4 per-call estimates (micro-USD), used for the "est. live" display and cap pre-checks. */
export const EST_MICRO_USD = { spark1: 18_000, sam: 2_500, spark2: 15_000, intent: 4_000 } as const;

/** Muse Spark Standard mode per 1M tokens: input $1.25, output (reasoning included) $4.25. SAM: $2.50 / 1,000 images. */
/** Missing usage is charged at the estimate, never at zero, so the caps cannot fail open. */
export function sparkCostMicroUsd(u: { inputTokens: number; outputTokens: number } | null, fallbackMicroUsd: number): number {
  if (!u || !Number.isFinite(u.inputTokens) || !Number.isFinite(u.outputTokens)) return fallbackMicroUsd;
  return Math.round(u.inputTokens * 1.25 + u.outputTokens * 4.25);
}
export const SAM_IMAGE_MICRO_USD = 2_500;

export type CallDeps = {
  transport: Transport;
  source: CallSource;
  sleep: (ms: number) => Promise<void>;
  nowMs: () => number;
  nowIso: () => string;
};

type Usage = CallDraft['usage'];

export function readUsage(json: unknown): Usage {
  const u = (json as { usage?: Record<string, unknown> } | null)?.usage;
  if (!u || typeof u !== 'object') return null;
  const input = u.input_tokens ?? u.prompt_tokens ?? u.inputTokens;
  const output = u.output_tokens ?? u.completion_tokens ?? u.outputTokens;
  // A usage object with neither count (e.g. only total_tokens) is unknown usage, charged at the
  // estimate by the caller. Reading it as 0 tokens would let the caps fail open.
  if (input === undefined && output === undefined) return null;
  const details = (u.output_tokens_details ?? u.completion_tokens_details) as Record<string, unknown> | undefined;
  return {
    inputTokens: Number(input ?? 0),
    outputTokens: Number(output ?? 0),
    reasoningTokens: Number(details?.reasoning_tokens ?? u.reasoning_tokens ?? u.reasoningTokens ?? 0),
  };
}

export async function callResponses(
  deps: CallDeps,
  body: Record<string, unknown>,
  meta: { model: string; estMicroUsd: number; price: (u: Usage, status: number) => number },
): Promise<{ outcome: RetryOutcome; calls: CallDraft[] }> {
  const outcome = await sendWithRetry(() => deps.transport({ path: '/responses', body }), { sleep: deps.sleep, nowMs: deps.nowMs });
  const calls: CallDraft[] = outcome.attempts.map((a) => {
    const id = (a.result?.json as { id?: unknown } | null)?.id;
    const usage = a.result ? readUsage(a.result.json) : null;
    const ok = a.status >= 200 && a.status < 300;
    return {
      callId: typeof id === 'string' && id ? id : `${deps.source}_${randomUUID().slice(0, 8)}`,
      model: meta.model,
      http: a.status,
      latencyMs: a.latencyMs,
      usage,
      costMicroUsd: deps.source === 'live' && ok ? meta.price(usage, a.status) : 0,
      estLiveCostMicroUsd: ok ? meta.estMicroUsd : 0,
      source: deps.source,
      createdAt: deps.nowIso(),
    };
  });
  return { outcome, calls };
}

/**
 * Non-2xx (or no response at all) → port failure. The reason-code list is fixed (§4-3, 30 names),
 * so 401/403 keep META_API_UNAVAILABLE, but the detail names the key: a mis-pasted key must not
 * read as a Meta outage on the first live run.
 */
export function httpFailure(label: string, final: HttpResult | null, calls: CallDraft[]): { ok: false; http: number; code: ReasonCode; detail: string; calls: CallDraft[] } {
  const status = final?.status ?? 0;
  const hint = status === 401 || status === 403 ? ': check the key (MODEL_API_KEY rejected)' : status === 0 ? ' (no response from the transport)' : '';
  return { ok: false, http: status, code: statusToReason(status), detail: `${label} HTTP ${status}${hint}`, calls };
}

/** Concatenated output_text parts of message items (Responses API `output` array, with live fallbacks). */
export function outputText(json: unknown): string | null {
  const root = json as Record<string, unknown> | null;
  if (!root || typeof root !== 'object') return null;
  const out = root.output;
  if (Array.isArray(out)) {
    const parts: string[] = [];
    for (const item of out as Record<string, unknown>[]) {
      if ((item?.type === 'output_text' || item?.type === 'text') && typeof item.text === 'string') {
        parts.push(item.text);
        continue;
      }
      if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
      for (const c of item.content as Record<string, unknown>[]) {
        if ((c?.type === 'output_text' || c?.type === 'text') && typeof c.text === 'string') parts.push(c.text);
      }
    }
    if (parts.length) return parts.join('');
  }
  if (typeof root.output_text === 'string' && root.output_text.length > 0) return root.output_text;
  const choices = root.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const msg = (choices[0] as Record<string, unknown> | null)?.message as Record<string, unknown> | undefined;
    if (typeof msg?.content === 'string') return msg.content;
  }
  return null;
}

/** Parse structured JSON text, tolerating optional markdown code fences returned by live endpoints. */
export function parseJsonOutput(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
    if (m) return JSON.parse(m[1]);
    throw new Error('output_text is not JSON');
  }
}

export function functionCalls(json: unknown): { name: string; arguments: string; callId: string }[] {
  const root = json as Record<string, unknown> | null;
  if (!root || typeof root !== 'object') return [];
  const out = root.output;
  if (Array.isArray(out)) {
    const direct = (out as Record<string, unknown>[])
      .filter((i) => i?.type === 'function_call')
      .map((i) => ({
        name: String(i.name ?? ''),
        arguments: typeof i.arguments === 'object' && i.arguments !== null ? JSON.stringify(i.arguments) : String(i.arguments ?? ''),
        callId: String(i.call_id ?? i.id ?? ''),
      }));
    if (direct.length) return direct;
  }
  const choices = root.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const msg = (choices[0] as Record<string, unknown> | null)?.message as Record<string, unknown> | undefined;
    const tcs = msg?.tool_calls;
    if (Array.isArray(tcs)) {
      return (tcs as Record<string, unknown>[]).map((tc) => {
        const fn = (tc?.function ?? {}) as Record<string, unknown>;
        return {
          name: String(fn.name ?? tc?.name ?? ''),
          arguments: typeof fn.arguments === 'object' && fn.arguments !== null ? JSON.stringify(fn.arguments) : String(fn.arguments ?? tc?.arguments ?? ''),
          callId: String(tc?.id ?? tc?.call_id ?? ''),
        };
      });
    }
  }
  return [];
}
