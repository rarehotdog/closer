// Retry policy (§3-4): retry only 429·500·503 (and transport errors), honor Retry-After, at most 2
// retries [가정]. 400·401·402·403·404·413: no retry. 504: no same-request retry.
import type { ReasonCode } from '../shared/reasons.ts';

export const MAX_RETRIES = 2;
export const RETRYABLE = new Set([0, 429, 500, 503]);
export const NO_RETRY = new Set([400, 401, 402, 403, 404, 413, 504]);

export type HttpResult = { status: number; headers: Record<string, string>; json: unknown };
export type Attempt = { status: number; latencyMs: number; result: HttpResult | null; error: string | null };
export type RetryOutcome = { final: HttpResult | null; attempts: Attempt[]; waitsMs: number[] };

export type RetryDeps = { sleep: (ms: number) => Promise<void>; nowMs: () => number; maxRetries?: number };

function retryAfterMs(h: Record<string, string>, attempt: number): number {
  const raw = h['retry-after'] ?? h['Retry-After'];
  const s = raw !== undefined ? Number(raw) : NaN;
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  return 500 * 2 ** attempt; // fallback backoff when the header is absent
}

export async function sendWithRetry(send: () => Promise<HttpResult>, deps: RetryDeps): Promise<RetryOutcome> {
  const max = deps.maxRetries ?? MAX_RETRIES;
  const attempts: Attempt[] = [];
  const waitsMs: number[] = [];
  for (let i = 0; ; i++) {
    const t0 = deps.nowMs();
    let res: HttpResult | null = null;
    let error: string | null = null;
    try {
      res = await send();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const status = res ? res.status : 0;
    attempts.push({ status, latencyMs: Math.max(0, Math.round(deps.nowMs() - t0)), result: res, error });
    if (status >= 200 && status < 300) return { final: res, attempts, waitsMs };
    if (!RETRYABLE.has(status) || i >= max) return { final: res, attempts, waitsMs };
    const wait = retryAfterMs(res?.headers ?? {}, i);
    waitsMs.push(wait);
    await deps.sleep(wait);
  }
}

export function statusToReason(status: number): ReasonCode {
  if (status === 400) return 'META_REQUEST_REJECTED';
  if (status === 413) return 'UNSUPPORTED_IMAGE';
  return 'META_API_UNAVAILABLE';
}
