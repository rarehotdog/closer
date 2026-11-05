// A closet photo can show more garments than one scan lists (16). The browser then scans overlapping
// parts of the same photo and merges the answers. Pure geometry here, so it can be tested.

/** Pixel rectangle, x2/y2 inclusive (the same convention as the scan's boxes). */
export type Rect = { x1: number; y1: number; x2: number; y2: number };

/**
 * Split a w x h photo into `cols` x `rows` tiles that overlap by `overlap` (a share of a tile's side),
 * so a garment cut by one tile edge is whole in the neighbouring tile.
 */
export function tileRects(w: number, h: number, cols: number, rows: number, overlap = 0.12): Rect[] {
  if (!(w > 0 && h > 0 && cols >= 1 && rows >= 1)) throw new Error('bad tile grid');
  const tw = w / cols;
  const th = h / rows;
  const ox = Math.round(tw * overlap);
  const oy = Math.round(th * overlap);
  const out: Rect[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out.push({
        x1: Math.max(0, Math.floor(c * tw) - ox),
        y1: Math.max(0, Math.floor(r * th) - oy),
        x2: Math.min(w - 1, Math.ceil((c + 1) * tw) - 1 + ox),
        y2: Math.min(h - 1, Math.ceil((r + 1) * th) - 1 + oy),
      });
    }
  }
  return out;
}

/** A box found in a tile, back in the full photo's pixels. */
export function toFullFrame(box: Rect, tile: Rect): Rect {
  return { x1: box.x1 + tile.x1, y1: box.y1 + tile.y1, x2: box.x2 + tile.x1, y2: box.y2 + tile.y1 };
}

const area = (b: Rect) => Math.max(0, b.x2 - b.x1 + 1) * Math.max(0, b.y2 - b.y1 + 1);

/** Intersection over the smaller box: 1 when one box sits inside the other. */
export function overlapOfSmaller(a: Rect, b: Rect): number {
  const ix = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) + 1;
  const iy = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) + 1;
  if (ix <= 0 || iy <= 0) return 0;
  return (ix * iy) / Math.min(area(a), area(b));
}

/**
 * Merge garments found in several tiles: the same garment seen in two overlapping tiles is kept once
 * (the larger box, which is usually the whole garment rather than a part cut by a tile edge).
 * `threshold` is the overlap-of-smaller above which two boxes count as one garment.
 */
export function mergeTileFinds<T extends { box: Rect }>(finds: T[], threshold = 0.6): T[] {
  const sorted = [...finds].sort((a, b) => area(b.box) - area(a.box));
  const kept: T[] = [];
  for (const f of sorted) {
    if (!kept.some((k) => overlapOfSmaller(k.box, f.box) >= threshold)) kept.push(f);
  }
  return kept;
}
