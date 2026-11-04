// Closet anatomy: the closet's own pieces grouped by layer, for the 3D view and its list.
// Pure data, no DOM. The canvas and the list draw from this one result, so both show the same
// pieces in the same states as My closet. It carries no prices and computes no new numbers.

export const LAYERS = ['outer', 'top', 'bottom', 'shoes'];
export const LAYER_LABEL = { outer: 'Outerwear rail', top: 'Tops shelf', bottom: 'Bottoms shelf', shoes: 'Shoe rack' };
export const AVAILABILITY_LABEL = { AVAILABLE: 'Available', LAUNDRY: 'In the laundry', REPAIR: 'At repair', STORED: 'Stored' };

/**
 * @param {Array<{itemId:string, slot:string, type:string, color:string, availability?:string, wearCount?:number, lastWorn?:string|null, wearLabel?:string|null}>} items  from GET /api/ws/:id/view
 * @param {Array<{itemId:string, status:string, line:string}>} reviewRows  from GET /api/ws/:id/review
 */
export function buildAnatomy(items, reviewRows) {
  const review = new Map((reviewRows || []).map((r) => [r.itemId, r]));
  const layers = LAYERS.map((slot) => ({ slot, label: LAYER_LABEL[slot], items: [] }));
  const bySlot = Object.fromEntries(LAYERS.map((s) => [s, 0]));
  const byAvailability = {};
  const byReview = {};
  const unplaced = [];
  for (const it of items || []) {
    const layer = layers.find((l) => l.slot === it.slot);
    if (!layer) { unplaced.push(it.itemId); continue; }
    const r = review.get(it.itemId) || null;
    const availability = it.availability || 'AVAILABLE';
    layer.items.push({
      itemId: it.itemId,
      slot: it.slot,
      type: it.type,
      color: it.color,
      availability,
      wearCount: it.wearCount ?? 0,
      lastWorn: it.lastWorn ?? null,
      wearLabel: it.wearLabel ?? null,
      review: r ? r.status : null,
      reviewLine: r ? r.line : null,
    });
    bySlot[it.slot] += 1;
    byAvailability[availability] = (byAvailability[availability] || 0) + 1;
    if (r) byReview[r.status] = (byReview[r.status] || 0) + 1;
  }
  for (const l of layers) l.items.sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
  const total = layers.reduce((s, l) => s + l.items.length, 0);
  return {
    layers,
    counts: { total, bySlot, byAvailability, byReview, unplaced },
    note: 'Same pieces and states as My closet. This view draws them in 3D and adds no numbers of its own.',
  };
}
