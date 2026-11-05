// Calendar dates are KST dates as 'YYYY-MM-DD'. The engine never reads the system clock (§3-6):
// callers inject `today` (and the demo clock offset).

export type IsoDate = string;

const RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(d: unknown): d is IsoDate {
  return typeof d === 'string' && RE.test(d);
}

function toUtcMs(d: IsoDate): number {
  if (!isIsoDate(d)) throw new Error(`not a YYYY-MM-DD date: ${String(d)}`);
  const [y, m, dd] = d.split('-').map(Number);
  return Date.UTC(y, m - 1, dd);
}

export function addDays(d: IsoDate, n: number): IsoDate {
  return new Date(toUtcMs(d) + n * 86_400_000).toISOString().slice(0, 10);
}

/** a − b in whole days. */
export function diffDays(a: IsoDate, b: IsoDate): number {
  return Math.round((toUtcMs(a) - toUtcMs(b)) / 86_400_000);
}

export function mmdd(d: IsoDate): string {
  return `${d.slice(5, 7)}/${d.slice(8, 10)}`;
}

/** KST calendar date of an instant. Only callers outside the engine use this. */
export function kstDateOf(instant: Date): IsoDate {
  return new Date(instant.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}
