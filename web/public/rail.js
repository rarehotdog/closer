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
 * Pure rotation tier from counted ledger facts (wearCount and 60-day review status).
 * Computes zero probabilities: every label names only the recorded wear count or review status.
 */
export function rotationHeatOf(meta) {
  const wears = meta && typeof meta.wearCount === 'number' && Number.isFinite(meta.wearCount) && meta.wearCount > 0
    ? Math.floor(meta.wearCount)
    : 0;
  const review = meta && typeof meta.review === 'string' ? meta.review : null;
  if (wears >= 3) {
    return { tier: 'hot', wears, shortLabel: `${wears}x · Active`, detailLabel: `${wears} confirmed wears` };
  }
  if (wears >= 1) {
    return { tier: 'warm', wears, shortLabel: `${wears}x`, detailLabel: `${wears} confirmed ${wears === 1 ? 'wear' : 'wears'}` };
  }
  if (review === 'CANDIDATE') {
    return { tier: 'cold', wears: 0, shortLabel: '0x · Review', detailLabel: '0 confirmed wears in 60d' };
  }
  return { tier: 'fresh', wears: 0, shortLabel: '0x', detailLabel: 'No confirmed wear yet' };
}

/** Places prioritized items in the centre of the rail and alternates outward so spotlighted pieces stand dead-centre. */
function centreOutward(sorted) {
  const n = sorted.length;
  if (n <= 2) return sorted;
  const out = new Array(n);
  const mid = Math.floor((n - 1) / 2);
  for (let i = 0; i < n; i++) {
    const offset = i === 0 ? 0 : (i % 2 === 1 ? Math.ceil(i / 2) : -Math.ceil(i / 2));
    out[mid + offset] = sorted[i];
  }
  return out;
}

/**
 * Lays the pieces out: tops and outerwear and bottoms on one rail (outerwear first, then tops, then
 * bottoms, each in the order given by default), shoes as pairs on the floor under it. `tags` is the ledger's
 * per-piece row map (GET /api/ws/:id/ledger → tags). Optional `opts.sort` ('rack' | 'review' | 'worn' | 'priced')
 * reorders hanging pieces using counted ledger facts only.
 */
export function railLayout(pieces, tags, opts) {
  const list = Array.isArray(pieces) ? pieces : [];
  const sortMode = opts && typeof opts.sort === 'string' ? opts.sort : 'rack';
  const hangingIn = list.filter((p) => p && p.slot in ORDER);
  const shoesIn = list.filter((p) => p && p.slot === 'shoes');
  const tagMap = tags || {};
  const rankTag = (id) => {
    const t = tagOf(tagMap[id] || null);
    if (!t) return 2;
    return t.sample ? 1 : 0;
  };
  let hanging = hangingIn
    .map((p, i) => ({ p, i, h: rotationHeatOf(p) }))
    .sort((a, b) => {
      if (sortMode === 'worn') {
        if (b.h.wears !== a.h.wears) return b.h.wears - a.h.wears;
      } else if (sortMode === 'priced') {
        const ra = rankTag(a.p.itemId);
        const rb = rankTag(b.p.itemId);
        if (ra !== rb) return ra - rb;
      } else if (sortMode === 'review') {
        const ca = a.h.tier === 'cold' ? 0 : a.h.tier === 'fresh' ? 1 : 2;
        const cb = b.h.tier === 'cold' ? 0 : b.h.tier === 'fresh' ? 1 : 2;
        if (ca !== cb) return ca - cb;
      }
      return ORDER[a.p.slot] - ORDER[b.p.slot] || a.i - b.i;
    })
    .map(({ p }) => p);

  if (sortMode === 'review' && hanging.length > 2) {
    hanging = centreOutward(hanging);
  }

  const n = hanging.length;
  const span = Math.max(n - 1, 0) * RAIL.spacing;
  const m = shoesIn.length;
  const shoeSpan = Math.max(m - 1, 0) * RAIL.shoeSpacing;
  const midIdx = (n - 1) / 2;
  const at = (p, x, idx, isHanging) => {
    const heat = rotationHeatOf(p);
    const spotlight = Boolean(isHanging && sortMode === 'review' && heat.tier === 'cold' && Math.abs(idx - midIdx) <= 1.6);
    return { itemId: p.itemId, slot: p.slot, type: p.type, x, tag: tagOf(tags ? tags[p.itemId] : null), ...(opts && opts.withHeat ? { heat, spotlight } : {}) };
  };
  return {
    hanging: hanging.map((p, i) => at(p, -span / 2 + i * RAIL.spacing, i, true)),
    shoes: shoesIn.map((p, j) => at(p, -shoeSpan / 2 + j * RAIL.shoeSpacing, j, false)),
    railLength: Math.max(span, shoeSpan) + 2 * RAIL.margin,
  };
}

/** The words on a tag: the amount as the ledger holds it, and a Sample mark for sample rows. Nothing else is computed. */
export function tagWords(tag, money) {
  if (!tag) return null;
  return { amount: money(tag.amount, tag.currency), mark: tag.sample ? 'SAMPLE' : '' };
}
