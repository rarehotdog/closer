// 실호출 기록: docs/live/live_check.json (2026-11-05, 1회) — 그 기록 밖의 응답 형태는 문서 예시 기반
// Transport = one POST to the Responses API. Mode resolution: mock is the default. Real mode
// refuses to start without MODEL_API_KEY, and is always refused in test processes.
import type { HttpResult } from '../engine/retry.ts';

export type TransportRequest = { path: '/responses'; body: Record<string, unknown> };
export type Transport = (req: TransportRequest) => Promise<HttpResult>;

/** Base URL from the Model API docs' examples. */
export const DEFAULT_BASE_URL = 'https://api.meta.ai/v1';

export class RealModeRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RealModeRefused';
  }
}

export type Mode = 'mock' | 'real';

export function resolveMode(env: Record<string, string | undefined>): Mode {
  const m = (env.CLOSER_MODE ?? '').trim() || 'mock';
  if (m !== 'mock' && m !== 'real') throw new Error(`CLOSER_MODE must be mock or real, got ${m}`);
  return m;
}

/**
 * The single code path that can reach the network. Throws unless a key is present and the process
 * is not a test run. The key is read from the environment and never logged or returned.
 */
export function createRealTransport(env: Record<string, string | undefined>): Transport {
  if (env.CLOSER_FORBID_REAL === '1') throw new RealModeRefused('real transport is forbidden in this process (tests)');
  const key = env.MODEL_API_KEY;
  if (!key || key.trim() === '') throw new RealModeRefused('MODEL_API_KEY is not set; real mode refuses to run');
  const base = ((env.META_API_BASE_URL ?? '').trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
  return async ({ path, body }) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, headers, json };
  };
}
