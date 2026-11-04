// The boutique rail: which pieces hang, in what order and where, and which carry a price tag.
// Pure (no DOM, no three.js) so the rules are tested under Node. A tag shows only a price row the
// closet ledger already holds; a piece without one gets no tag, and a sample row stays marked.

export const RAIL = {
  spacing: 0.6, // metres between hooks
  shoeSpacing: 0.46, // between pairs on the floor
  railY: 1.74, // rail height above the floor
  margin: 0.55, // rail beyond the first and last hook
};

const ORDER = { outer: 0, top: 1, bottom: 2 };

/** One ledger row as a tag, or null. Only a finite positive amount in a known currency becomes a tag. */
export function tagOf(row) {
  if (!row || typeof row.amount !== 'number' || !Number.isFinite(row.amount) || row.amount <= 0) return null;
  if (!['KRW', 'USD', 'EUR'].includes(row.currency)) return null;
  return {
    amount: row.amount,
    currency: row.currency,
    sample: row.source === 'sample',
    traded: row.priceType === 'TRADE',
    platform: String(row.platformName || row.platform || '').split(' (')[0],
  };
}

/**
 * Lays the pieces out: tops and outerwear and bottoms on one rail (outerwear first, then tops, then
 * bottoms, each in the order given), shoes as pairs on the floor under it. `tags` is the ledger's
 * per-piece row map (GET /api/ws/:id/ledger → tags).
 */
export function railLayout(pieces, tags) {
  const list = Array.isArray(pieces) ? pieces : [];
  const hangingIn = list.filter((p) => p && p.slot in ORDER);
  const shoesIn = list.filter((p) => p && p.slot === 'shoes');
  const hanging = hangingIn
    .map((p, i) => ({ p, i }))
    .sort((a, b) => ORDER[a.p.slot] - ORDER[b.p.slot] || a.i - b.i)
    .map(({ p }) => p);
  const n = hanging.length;
  const span = Math.max(n - 1, 0) * RAIL.spacing;
  const m = shoesIn.length;
  const shoeSpan = Math.max(m - 1, 0) * RAIL.shoeSpacing;
  const at = (p, x) => ({ itemId: p.itemId, slot: p.slot, type: p.type, x, tag: tagOf(tags ? tags[p.itemId] : null) });
  return {
    hanging: hanging.map((p, i) => at(p, -span / 2 + i * RAIL.spacing)),
    shoes: shoesIn.map((p, j) => at(p, -shoeSpan / 2 + j * RAIL.shoeSpacing)),
    railLength: Math.max(span, shoeSpan) + 2 * RAIL.margin,
  };
}

/** The words on a tag: the amount as the ledger holds it, and a Sample mark for sample rows. Nothing else is computed. */
export function tagWords(tag, money) {
  if (!tag) return null;
  return { amount: money(tag.amount, tag.currency), mark: tag.sample ? 'SAMPLE' : '' };
}
