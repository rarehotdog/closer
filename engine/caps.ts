// Kill switch (K1, CLOSER_KILL) and money caps (§3-6 flags, §0-7). Pure: `now` is injected.

export const KILL_TTL_MS = 10 * 60 * 1000;

/** From this instant the visitor cap is $0 (date condition written before rc1, §0-7 / §6-1). */
export const VISITOR_ZERO_FROM = '2026-11-19T00:00:00+09:00';

export type Caps = { appTotalMicroUsd: number; visitorDayMicroUsd: number; sessionMicroUsd: number; visitorZeroFrom: string };

/** Candidate values from the plan (§0-7, [가정]): total $60 · visitor day $3 · session $0.25. */
export const CANDIDATE_CAPS: Caps = { appTotalMicroUsd: 60_000_000, visitorDayMicroUsd: 3_000_000, sessionMicroUsd: 250_000, visitorZeroFrom: VISITOR_ZERO_FROM };

/**
 * No-answer default for §9 Q3 (provisional freeze): spike+dev+recording total $20, visitor live
 * calls 0 ('Replay & ledger mode'). The session cap keeps the candidate $0.25 (not covered by the default).
 */
export const PROVISIONAL_CAPS: Caps = { appTotalMicroUsd: 20_000_000, visitorDayMicroUsd: 0, sessionMicroUsd: 250_000, visitorZeroFrom: VISITOR_ZERO_FROM };

export type KillFlag = { on: boolean; setAt: string | null; ttlMs: number };

export function killActive(k: KillFlag, now: Date): boolean {
  if (!k.on || !k.setAt) return false;
  return now.getTime() < new Date(k.setAt).getTime() + k.ttlMs;
}

export function visitorDayCap(caps: Caps, now: Date): number {
  return now.getTime() >= new Date(caps.visitorZeroFrom).getTime() ? 0 : caps.visitorDayMicroUsd;
}

/** A cap blocks when it is already reached, or when this call's estimated cost would pass it. Free (mock) calls pass a $0 cap. */
export function capBlocks(spent: number, est: number, cap: number): boolean {
  if (spent >= cap && (cap > 0 || est > 0)) return true;
  return spent + est > cap;
}

export type Spend = { appTotal: number; visitorDay: number; session: number };

export type GateResult = { ok: true } | { ok: false; code: 'META_DISABLED' | 'CALL_CAP_REACHED'; detail: string };

export function gateModelCall(args: { now: Date; kill: KillFlag; caps: Caps; spend: Spend; isVisitor: boolean; estMicroUsd: number }): GateResult {
  if (killActive(args.kill, args.now)) return { ok: false, code: 'META_DISABLED', detail: 'CLOSER_KILL is on' };
  const { caps, spend, estMicroUsd: est } = args;
  if (capBlocks(spend.appTotal, est, caps.appTotalMicroUsd)) return { ok: false, code: 'CALL_CAP_REACHED', detail: 'app total cap' };
  if (capBlocks(spend.session, est, caps.sessionMicroUsd)) return { ok: false, code: 'CALL_CAP_REACHED', detail: 'session cap' };
  if (args.isVisitor && capBlocks(spend.visitorDay, est, visitorDayCap(caps, args.now))) {
    return { ok: false, code: 'CALL_CAP_REACHED', detail: 'visitor day cap' };
  }
  return { ok: true };
}
