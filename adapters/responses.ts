// 미검증 — 문서 예시 기반, 실호출 0
// Shared Responses-API plumbing: send with the retry policy, turn every HTTP attempt into a call
// row, read output text / function calls, and price usage.
import { randomUUID } from 'node:crypto';
import type { CallSource } from '../shared/ledger.ts';
import { sendWithRetry, type RetryOutcome } from '../engine/retry.ts';
import type { Transport } from './transport.ts';
import type { CallDraft } from './types.ts';

export const SPARK_MODEL = 'muse-spark-1.3';
export const SAM_MODEL = 'sam-3.1';

/** Plan §3-4 per-call estimates (micro-USD), used for the "est. live" display and cap pre-checks. */
export const EST_MICRO_USD = { spark1: 18_000, sam: 2_500, spark2: 15_000 } as const;

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
  const details = u.output_tokens_details as Record<string, unknown> | undefined;
  return {
    inputTokens: Number(u.input_tokens ?? 0),
    outputTokens: Number(u.output_tokens ?? 0),
    reasoningTokens: Number(details?.reasoning_tokens ?? 0),
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

/** Concatenated output_text parts of message items (Responses API `output` array). */
export function outputText(json: unknown): string | null {
  const out = (json as { output?: unknown[] } | null)?.output;
  if (!Array.isArray(out)) return null;
  const parts: string[] = [];
  for (const item of out as Record<string, unknown>[]) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const c of item.content as Record<string, unknown>[]) if (c?.type === 'output_text' && typeof c.text === 'string') parts.push(c.text);
  }
  return parts.length ? parts.join('') : null;
}

export function functionCalls(json: unknown): { name: string; arguments: string; callId: string }[] {
  const out = (json as { output?: unknown[] } | null)?.output;
  if (!Array.isArray(out)) return [];
  return (out as Record<string, unknown>[])
    .filter((i) => i?.type === 'function_call')
    .map((i) => ({ name: String(i.name ?? ''), arguments: String(i.arguments ?? ''), callId: String(i.call_id ?? '') }));
}
