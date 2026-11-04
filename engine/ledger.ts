// The closet ledger: the owner's pieces and the prices seen for them, at a glance and counted.
// Each currency stands alone (nothing is converted) and the owner's own rows and the demo sample
// rows are summed apart, never together. A total is the sum of one latest row per piece, with the
// number of pieces it covers next to it; a piece without a price is left out, not counted as zero.
// Pure: no I/O. The inputs come from the ledger state, ExtrasStore and the 60-day review.
import type { Item } from '../shared/wardrobe.ts';
import { PLATFORM_INFO, fmt, type Currency, type Evidence, type Platform } from './market.ts';
import { DEFAULT_WINDOW_DAYS } from './review.ts';

/** KRW, USD, EUR: the order every list in the ledger follows. */
export const LEDGER_CURRENCIES: readonly Currency[] = ['KRW', 'USD', 'EUR'];

export type LedgerRow = {
  evidenceId: string;
  itemId: string;
  amount: number;
  currency: Currency;
  platform: string;
  platformName: string;
  priceType: 'ASK' | 'TRADE';
  source: 'owner_entered' | 'sample';
  retrievedAt: string;
};
/** ask / trade: how many of those pieces are counted at an asking price vs a traded price. */
export type SideTotal = { total: number; pieces: number; ask: number; trade: number };
export type CurrencyLedger = { currency: Currency; owner: SideTotal; sample: SideTotal };
export type ClosetLedger = {
  /** Confirmed pieces in the closet. */
  pieces: number;
  /** Pieces with at least one price row (owner or sample). */
  withEvidence: number;
  /** Pieces with at least one owner-entered row. */
  withOwnerEvidence: number;
  /** Pieces whose rows are all sample rows. */
  sampleOnly: number;
  /** pieces = withEvidence + withoutEvidence. */
  withoutEvidence: number;
  /** KRW, USD, EUR order; only currencies with at least one row. */
  byCurrency: CurrencyLedger[];
  /** Per itemId with any row: the row its price tag shows. */
  tags: Record<string, LedgerRow>;
  net: { byCurrency: { currency: Currency; total: number; pieces: number }[]; pieces: number; pricedNoNet: number };
  wear: { windowDays: number; recentWear: number; candidates: number; tooFewRecords: number; exempt: number };
  /** Plain sentences that carry the counting rule. */
  lines: { headline: string; evidence: string; net: string; wear: string };
  note: string;
};

export type LedgerDecision = { itemId: string; at: string; sell: { currency: string; scenario: { net: number | null } | null } };
export type LedgerReviewRow = { itemId: string; status: string; windowDays: number };
export type LedgerInput = {
  items: readonly Pick<Item, 'itemId' | 'ownership'>[];
  evidence: readonly Evidence[];
  decisions: readonly LedgerDecision[];
  reviewRows: readonly LedgerReviewRow[];
};

export const LEDGER_NOTE = 'Each currency stands alone; nothing is converted. Asking prices are not sales. Sample prices are demo rows and are never added to yours.';

/**
 * Newest first: the larger retrievedAt; on the same day a traded price before an asking price,
 * then evidenceId ascending. The first row in this order is a piece's "latest" row.
 */
export function newerFirst(a: Pick<Evidence, 'retrievedAt' | 'priceType' | 'evidenceId'>, b: Pick<Evidence, 'retrievedAt' | 'priceType' | 'evidenceId'>): number {
  if (a.retrievedAt !== b.retrievedAt) return a.retrievedAt > b.retrievedAt ? -1 : 1;
  if (a.priceType !== b.priceType) return a.priceType === 'TRADE' ? -1 : 1;
  return a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : 0;
}

function latestOf(rows: readonly Evidence[]): Evidence | null {
  let best: Evidence | null = null;
  for (const r of rows) if (best === null || newerFirst(r, best) < 0) best = r;
  return best;
}

/** Whole won for KRW, cents for USD and EUR. */
function roundIn(n: number, c: Currency): number {
  const r = c === 'KRW' ? Math.round(n) : Math.round(n * 100) / 100;
  return r === 0 ? 0 : r;
}

const pl = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function toRow(e: Evidence): LedgerRow {
  const info = PLATFORM_INFO[e.platform as Platform];
  return {
    evidenceId: e.evidenceId, itemId: e.itemId, amount: e.amount, currency: e.currency, platform: e.platform,
    platformName: info ? info.name : e.platform, priceType: e.priceType, source: e.source, retrievedAt: e.retrievedAt,
  };
}

function sideTotal(latestRows: readonly Evidence[], c: Currency): SideTotal {
  let sum = 0;
  let ask = 0;
  let trade = 0;
  for (const r of latestRows) {
    sum += r.amount;
    if (r.priceType === 'TRADE') trade++;
    else ask++;
  }
  return { total: roundIn(sum, c), pieces: latestRows.length, ask, trade };
}

function kinds(s: SideTotal): string {
  return [s.trade ? `${s.trade} traded` : null, s.ask ? `${s.ask} asking` : null].filter(Boolean).join(', ');
}

export function closetLedger(input: LedgerInput): ClosetLedger {
  const ids = [...new Set(input.items.filter((i) => i.ownership === 'CONFIRMED').map((i) => i.itemId))].sort();
  const inCloset = new Set(ids);
  const byItem = new Map<string, Evidence[]>();
  for (const e of input.evidence) {
    if (!inCloset.has(e.itemId) || !LEDGER_CURRENCIES.includes(e.currency)) continue;
    const list = byItem.get(e.itemId) ?? [];
    list.push(e);
    byItem.set(e.itemId, list);
  }

  // Counts of pieces by the rows they have.
  let withOwnerEvidence = 0;
  let sampleOnly = 0;
  for (const rows of byItem.values()) {
    if (rows.some((r) => r.source === 'owner_entered')) withOwnerEvidence++;
    else sampleOnly++;
  }
  const withEvidence = byItem.size;

  // Totals: one latest row per piece, per currency and per source; owner and sample never pooled.
  const byCurrency: CurrencyLedger[] = [];
  for (const c of LEDGER_CURRENCIES) {
    const owner: Evidence[] = [];
    const sample: Evidence[] = [];
    for (const rows of byItem.values()) {
      const o = latestOf(rows.filter((r) => r.currency === c && r.source === 'owner_entered'));
      const s = latestOf(rows.filter((r) => r.currency === c && r.source === 'sample'));
      if (o) owner.push(o);
      if (s) sample.push(s);
    }
    if (owner.length + sample.length === 0) continue;
    byCurrency.push({ currency: c, owner: sideTotal(owner, c), sample: sideTotal(sample, c) });
  }

  // Price tags: the latest owner row if the piece has one, else the latest sample row, in the
  // first currency (KRW, USD, EUR) that has a row of that source.
  const tags: Record<string, LedgerRow> = {};
  for (const id of ids) {
    const rows = byItem.get(id);
    if (!rows) continue;
    const source = rows.some((r) => r.source === 'owner_entered') ? 'owner_entered' : 'sample';
    const mine = rows.filter((r) => r.source === source);
    const c = LEDGER_CURRENCIES.find((x) => mine.some((r) => r.currency === x));
    const tag = c ? latestOf(mine.filter((r) => r.currency === c)) : null;
    if (tag) tags[id] = toRow(tag);
  }

  // Net: each piece's latest saved position (by 'at'; on a tie the later one in the input) counts
  // only when its net is a number, i.e. every cost line was checked when it was saved.
  const lastPosition = new Map<string, LedgerDecision>();
  for (const d of input.decisions) {
    if (!inCloset.has(d.itemId)) continue;
    const prev = lastPosition.get(d.itemId);
    if (!prev || d.at >= prev.at) lastPosition.set(d.itemId, d);
  }
  const netSum = new Map<Currency, { sum: number; pieces: number }>();
  const withNet = new Set<string>();
  for (const [itemId, d] of lastPosition) {
    const net = d.sell.scenario ? d.sell.scenario.net : null;
    const c = d.sell.currency as Currency;
    if (typeof net !== 'number' || !Number.isFinite(net) || !LEDGER_CURRENCIES.includes(c)) continue;
    const acc = netSum.get(c) ?? { sum: 0, pieces: 0 };
    acc.sum += net;
    acc.pieces++;
    netSum.set(c, acc);
    withNet.add(itemId);
  }
  const netByCurrency = LEDGER_CURRENCIES.filter((c) => netSum.has(c)).map((c) => ({ currency: c, total: roundIn(netSum.get(c)!.sum, c), pieces: netSum.get(c)!.pieces }));
  const pricedNoNet = [...byItem.keys()].filter((id) => !withNet.has(id)).length;

  // Wear: the 60-day review rows of the pieces in the closet.
  const review = input.reviewRows.filter((r) => inCloset.has(r.itemId));
  const count = (...st: string[]) => review.filter((r) => st.includes(r.status)).length;
  const wear = {
    windowDays: review[0]?.windowDays ?? input.reviewRows[0]?.windowDays ?? DEFAULT_WINDOW_DAYS,
    recentWear: count('RECENT_WEAR'),
    candidates: count('CANDIDATE'),
    tooFewRecords: count('TOO_NEW', 'LOW_RECORDS'),
    exempt: count('EXEMPT'),
  };

  const pieces = ids.length;
  const withoutEvidence = pieces - withEvidence;
  const of = `of ${pl(pieces, 'piece')}`;
  const headline = withEvidence === 0
    ? `No prices yet on your ${pl(pieces, 'piece')}. Add one you saw on any piece.`
    : `${byCurrency.flatMap((cl) => [
      cl.owner.pieces ? `${fmt(cl.owner.total, cl.currency)} on ${cl.owner.pieces} ${of} at the latest price you entered for each (${kinds(cl.owner)})` : null,
      cl.sample.pieces ? `Sample ${fmt(cl.sample.total, cl.currency)} on ${cl.sample.pieces} ${of} at the latest sample price for each (${kinds(cl.sample)})${cl.owner.pieces ? ', kept apart from yours' : ''}` : null,
    ].filter(Boolean)).join('; ')}.`;
  const evidence = `${withEvidence} ${of} ${withEvidence === 1 ? 'has' : 'have'} a price (${withOwnerEvidence} with a price you entered, ${sampleOnly} with sample prices only); the other ${withoutEvidence} ${withoutEvidence === 1 ? 'has none yet and is' : 'have none yet and are'} not counted as zero.`;
  const netPhrases = netByCurrency.map((n) => (n.total < 0 ? `costs over the price by ${fmt(-n.total, n.currency)} on ${pl(n.pieces, 'piece')}` : `${fmt(n.total, n.currency)} on ${pl(n.pieces, 'piece')}`));
  const rest = pricedNoNet ? ` ${pl(pricedNoNet, 'other priced piece')} ${pricedNoNet === 1 ? 'has' : 'have'} no net worked out yet.` : '';
  const netLine = netByCurrency.length === 0
    ? 'No net worked out yet. Open Keep or let go? on a piece and check its costs.'
    : netByCurrency.every((n) => n.total >= 0)
      ? `You would receive ${netPhrases.join(' and ')} at the prices you tested, every cost checked.${rest}`
      : `At the prices you tested, every cost checked: ${netPhrases.join('; ')}.${rest}`;
  const wearLine = `Last ${wear.windowDays} days, from confirmed wear records: ${pl(wear.recentWear, 'piece')} worn at least once, ${wear.candidates} with no confirmed wear, ${wear.tooFewRecords} with too few records to say, ${wear.exempt} left out (stored or kept until a date you set). Days without a record are unknown.`;

  return {
    pieces, withEvidence, withOwnerEvidence, sampleOnly, withoutEvidence,
    byCurrency, tags,
    net: { byCurrency: netByCurrency, pieces: withNet.size, pricedNoNet },
    wear,
    lines: { headline, evidence, net: netLine, wear: wearLine },
    note: LEDGER_NOTE,
  };
}
