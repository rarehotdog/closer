// Deterministic local pixel scanner for whole-closet / rack photos when no live model API key is set.
// Zero mock data: every box, silhouette mask, and ColorFamily is measured directly from the uploaded
// image's RGB pixels, and operations created from this scanner record modelCalls = 0 with an explicit
// 'Local pixel scan · no Meta call' label so it is never mistaken for a model response.
import { GARMENT_TYPES, type ColorFamily, type Formality, type GarmentType, type Slot } from '../shared/wardrobe.ts';
import { maskColor, rgbToLab, type Lab, type PixelSource } from './color.ts';
import { encodeMockRle, type MaskRaster, type PixelBox } from './coords.ts';

export type ScannedPiece = {
  cardId: number;
  slot: Slot;
  type: GarmentType;
  color: ColorFamily;
  formality: Formality;
  normBox: [number, number, number, number];
  box: PixelBox;
  mask: { x: number; y: number; w: number; h: number; rle: string };
};

function labDist(a: Lab, b: Lab): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function medianVec(labs: Lab[]): Lab {
  if (labs.length === 0) return [75, 0, 5];
  const pick = (k: 0 | 1 | 2) => {
    const xs = labs.map((v) => v[k]).sort((a, b) => a - b);
    return xs[xs.length >> 1];
  };
  return [pick(0), pick(1), pick(2)];
}

type Grid = {
  gw: number;
  gh: number;
  sx: number;
  sy: number;
  lab: Lab[];
  dx: Float32Array;
  dy: Float32Array;
};

function buildGrid(src: PixelSource): Grid {
  const scale = Math.min(1, 240 / Math.max(src.w, src.h));
  const gw = Math.max(48, Math.round(src.w * scale));
  const gh = Math.max(48, Math.round(src.h * scale));
  const sx = src.w / gw;
  const sy = src.h / gh;
  const lab: Lab[] = new Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    const py = Math.min(src.h - 1, Math.floor((y + 0.5) * sy));
    for (let x = 0; x < gw; x++) {
      const px = Math.min(src.w - 1, Math.floor((x + 0.5) * sx));
      lab[y * gw + x] = rgbToLab(src.rgbAt(px, py));
    }
  }
  const dx = new Float32Array(gw * gh);
  const dy = new Float32Array(gw * gh);
  for (let y = 1; y < gh - 1; y++) {
    for (let x = 1; x < gw - 1; x++) {
      const i = y * gw + x;
      dx[i] = labDist(lab[i + 1], lab[i - 1]) * 0.5;
      dy[i] = labDist(lab[i + gw], lab[i - gw]) * 0.5;
    }
  }
  return { gw, gh, sx, sy, lab, dx, dy };
}

function findCabinetBounds(g: Grid): { xMin: number; xMax: number; rodY: number; wallLab: Lab } {
  const { gw, gh, lab, dx, dy } = g;
  const yLo = Math.floor(gh * 0.18);
  const yHi = Math.floor(gh * 0.82);

  // Detect strong vertical cabinet door/wall edges on left [0.06..0.24] and right [0.74..0.94].
  let xMin = Math.floor(gw * 0.08);
  let bestL = 0;
  for (let x = Math.floor(gw * 0.07); x <= Math.floor(gw * 0.24); x++) {
    let sum = 0;
    for (let y = yLo; y <= yHi; y++) sum += dx[y * gw + x];
    const avg = sum / Math.max(1, yHi - yLo + 1);
    if (avg > bestL && avg > 4.2) {
      bestL = avg;
      xMin = x + 2;
    }
  }

  let xMax = Math.ceil(gw * 0.92);
  let bestR = 0;
  for (let x = Math.floor(gw * 0.74); x <= Math.floor(gw * 0.93); x++) {
    let sum = 0;
    for (let y = yLo; y <= yHi; y++) sum += dx[y * gw + x];
    const avg = sum / Math.max(1, yHi - yLo + 1);
    if (avg > bestR && avg > 4.2) {
      bestR = avg;
      xMax = x - 2;
    }
  }
  if (xMax - xMin < Math.floor(gw * 0.42)) {
    xMin = Math.floor(gw * 0.08);
    xMax = Math.ceil(gw * 0.92);
  }

  // Detect horizontal hanger rod in y in [0.11..0.22].
  let rodY = Math.floor(gh * 0.16);
  let bestRod = 0;
  for (let y = Math.floor(gh * 0.11); y <= Math.floor(gh * 0.22); y++) {
    let sum = 0;
    for (let x = xMin + 4; x < xMax - 4; x++) sum += dy[y * gw + x];
    const avg = sum / Math.max(1, xMax - xMin - 8);
    if (avg > bestRod && avg > 4.5) {
      bestRod = avg;
      rodY = y;
    }
  }

  // Sample neutral cabinet ceiling / back wall Lab just above the rod and inner walls.
  const wallSamples: Lab[] = [];
  const wy0 = Math.max(2, Math.floor(rodY * 0.45));
  const wy1 = Math.max(wy0 + 2, rodY - 3);
  for (let y = wy0; y <= wy1; y++) {
    for (let x = xMin + 4; x < xMax - 4; x += 2) wallSamples.push(lab[y * gw + x]);
  }
  for (let y = yLo; y <= yHi; y += 3) {
    if (xMin > 3) wallSamples.push(lab[y * gw + Math.max(1, xMin - 3)]);
    if (xMax < gw - 4) wallSamples.push(lab[y * gw + Math.min(gw - 2, xMax + 3)]);
  }
  return { xMin, xMax, rodY, wallLab: medianVec(wallSamples) };
}

function columnBandLab(g: Grid, x: number, y1: number, y2: number): Lab {
  const samples: Lab[] = [];
  for (let y = y1; y <= y2; y += 2) samples.push(g.lab[y * g.gw + x]);
  return medianVec(samples);
}

/** True when a span looks like a boxy hanging fabric shelf organizer rather than hanging garments. */
function isShelfOrganizer(g: Grid, x1: number, x2: number, y1: number, y2: number, wallLab: Lab): boolean {
  const spanW = x2 - x1;
  if (spanW < Math.floor(g.gw * 0.10)) return false;
  let sumDx = 0;
  let sumDy = 0;
  const labs: Lab[] = [];
  for (let y = y1; y <= y2; y++) {
    for (let x = x1 + 2; x < x2 - 2; x++) {
      const i = y * g.gw + x;
      sumDx += g.dx[i];
      sumDy += g.dy[i];
      if ((x + y) % 3 === 0) labs.push(g.lab[i]);
    }
  }
  const med = medianVec(labs);
  const neutralLight = med[0] > 64 && Math.hypot(med[1], med[2]) < 19;
  // Shelf organizers have neutral beige/white fabric, wide flat pockets, and horizontal pocket borders >= vertical folds.
  return (labDist(med, wallLab) < 20 || neutralLight) && sumDy > sumDx * 0.88;
}

function segmentBandColumns(
  g: Grid,
  xStart: number,
  xEnd: number,
  y1: number,
  y2: number,
  minWidth: number,
  maxWidth: number,
): Array<[number, number]> {
  const n = xEnd - xStart + 1;
  if (n < minWidth) return [];
  const colLab: Lab[] = new Array(n);
  const vEdge = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = xStart + i;
    colLab[i] = columnBandLab(g, x, y1, y2);
    let e = 0;
    for (let y = y1; y <= y2; y++) e += g.dx[y * g.gw + x];
    vEdge[i] = e / Math.max(1, y2 - y1 + 1);
  }
  const seam = new Float32Array(n);
  const win = Math.max(2, Math.round(minWidth * 0.35));
  for (let i = win; i < n - win; i++) {
    const left = medianVec(colLab.slice(i - win, i));
    const right = medianVec(colLab.slice(i, i + win));
    seam[i] = labDist(left, right) + vEdge[i] * 0.85;
  }

  const cuts: number[] = [0];
  let cursor = 0;
  while (cursor + minWidth < n) {
    const searchLo = cursor + minWidth;
    const searchHi = Math.min(n - minWidth, cursor + maxWidth);
    if (searchLo > searchHi) break;
    let bestIdx = -1;
    let bestPeak = 0;
    for (let i = searchLo; i <= searchHi; i++) {
      const isPeak = seam[i] >= seam[i - 1] && seam[i] >= seam[i + 1];
      if (isPeak && seam[i] > bestPeak) {
        bestPeak = seam[i];
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && bestPeak >= 7.5) {
      cuts.push(bestIdx);
      cursor = bestIdx;
    } else if (cursor + maxWidth < n - minWidth) {
      // Wide region without a sharp color jump (e.g. two black jackets side by side): split at strongest vertical fold seam.
      let foldIdx = searchLo;
      let foldMax = -1;
      for (let i = searchLo; i <= searchHi; i++) {
        if (seam[i] > foldMax) {
          foldMax = seam[i];
          foldIdx = i;
        }
      }
      cuts.push(foldIdx);
      cursor = foldIdx;
    } else {
      break;
    }
  }
  cuts.push(n - 1);

  const spans: Array<[number, number]> = [];
  for (let k = 0; k < cuts.length - 1; k++) {
    const a = xStart + cuts[k];
    const b = xStart + cuts[k + 1];
    if (b - a >= Math.max(5, Math.floor(minWidth * 0.75))) spans.push([a, b]);
  }
  return spans;
}

function buildSilhouetteMask(
  src: PixelSource,
  box: PixelBox,
  wallLab: Lab,
  hanging: boolean,
): MaskRaster {
  const mw = Math.max(1, box.x2 - box.x1);
  const mh = Math.max(1, box.y2 - box.y1);
  const bits = new Uint8Array(mw * mh);

  // Sample core Lab in the central body of the box.
  const coreLabs: Lab[] = [];
  const cx0 = Math.floor(mw * 0.22), cx1 = Math.max(cx0 + 1, Math.ceil(mw * 0.78));
  const cy0 = Math.floor(mh * 0.16), cy1 = Math.max(cy0 + 1, Math.ceil(mh * 0.84));
  const step = Math.max(2, Math.floor(Math.min(mw, mh) / 24));
  for (let yy = cy0; yy < cy1; yy += step) {
    for (let xx = cx0; xx < cx1; xx += step) {
      coreLabs.push(rgbToLab(src.rgbAt(box.x1 + xx, box.y1 + yy)));
    }
  }
  const coreLab = medianVec(coreLabs);
  const coreWallDist = labDist(coreLab, wallLab);

  // Coarse mask grid for speed on large boxes, upsampled cleanly.
  const cell = Math.max(1, Math.floor(Math.max(mw, mh) / 140));
  const cw = Math.ceil(mw / cell);
  const ch = Math.ceil(mh / cell);
  const coarse = new Uint8Array(cw * ch);

  for (let cy = 0; cy < ch; cy++) {
    const v = (cy + 0.5) / ch;
    // Gentle hanger-shoulder taper at the very top and slight hem rounding at the corners.
    const halfSpan = hanging && v < 0.11
      ? 0.20 + (v / 0.11) * 0.29
      : v > 0.95
        ? 0.46
        : 0.49;
    for (let cx = 0; cx < cw; cx++) {
      const u = (cx + 0.5) / cw;
      if (Math.abs(u - 0.5) > halfSpan) continue;
      const px = Math.min(src.w - 1, box.x1 + Math.floor((cx + 0.5) * cell));
      const py = Math.min(src.h - 1, box.y1 + Math.floor((cy + 0.5) * cell));
      const pLab = rgbToLab(src.rgbAt(px, py));
      const dCore = labDist(pLab, coreLab);
      const dWall = labDist(pLab, wallLab);
      const nearBorder = u < 0.10 || u > 0.90 || v < 0.08 || v > 0.93;
      const keep = !nearBorder
        ? (coreWallDist <= 15 || dWall > 8.5 || dCore < dWall)
        : coreWallDist > 15
          ? dWall > 11.5 || dCore < dWall * 0.82
          : dCore < 14;
      if (keep) coarse[cy * cw + cx] = 1;
    }
  }

  let onCount = 0;
  for (let i = 0; i < coarse.length; i++) onCount += coarse[i];
  const minCoverage = cw * ch * 0.36;

  for (let yy = 0; yy < mh; yy++) {
    const cy = Math.min(ch - 1, Math.floor(yy / cell));
    const v = (yy + 0.5) / mh;
    // Smooth 1px curve at hanger shoulders and bottom corners so cut-outs never stair-step.
    const halfSpan = hanging && v < 0.095
      ? 0.18 + Math.sin((v / 0.095) * (Math.PI / 2)) * 0.305
      : v > 0.96
        ? 0.485 - ((v - 0.96) / 0.04) * 0.035
        : 0.485;
    for (let xx = 0; xx < mw; xx++) {
      const u = (xx + 0.5) / mw;
      if (Math.abs(u - 0.5) > halfSpan) continue;
      const inner = u >= 0.12 && u <= 0.88 && v >= 0.10 && v <= 0.90;
      if (inner || onCount < minCoverage) {
        bits[yy * mw + xx] = 1;
      } else {
        const cx = Math.min(cw - 1, Math.floor(xx / cell));
        bits[yy * mw + xx] = coarse[cy * cw + cx];
      }
    }
  }
  return { x: box.x1, y: box.y1, w: mw, h: mh, bits };
}

function classifyGarment(
  g: Grid,
  gx1: number,
  gy1: number,
  gx2: number,
  gy2: number,
  color: ColorFamily,
  upperRail: boolean,
): { type: GarmentType; formality: Formality } {
  const relH = (gy2 - gy1) / g.gh;
  const relW = (gx2 - gx1) / g.gw;
  let tex = 0;
  let count = 0;
  for (let y = gy1 + 2; y < gy2 - 2; y += 2) {
    for (let x = gx1 + 1; x < gx2 - 1; x++) {
      const i = y * g.gw + x;
      tex += g.dx[i] + g.dy[i];
      count++;
    }
  }
  const meanTex = count ? tex / count : 0;

  if (!upperRail) {
    if (relH > 0.24 && relW < 0.13 && (color === 'black' || color === 'charcoal' || color === 'gray' || color === 'navy' || color === 'beige')) {
      return { type: 'trousers', formality: 'mid' };
    }
    if (relW >= 0.12 && (color === 'brown' || color === 'black' || color === 'navy' || color === 'charcoal')) {
      return { type: 'jacket', formality: 'low' };
    }
    return { type: 'knit', formality: 'mid' };
  }

  if (relH >= 0.54) {
    return { type: 'coat', formality: color === 'black' || color === 'navy' || color === 'charcoal' || color === 'beige' ? 'high' : 'mid' };
  }
  if (color === 'black' || color === 'navy' || color === 'brown' || color === 'charcoal') {
    if (relW >= 0.095 || relH >= 0.38) {
      return { type: 'jacket', formality: meanTex > 6.5 ? 'low' : 'high' };
    }
  }
  if (color === 'blue' && meanTex < 6.0) {
    return { type: 'dress_shirt', formality: 'mid' };
  }
  if (color === 'white' || color === 'beige' || color === 'gray' || color === 'pink' || color === 'yellow' || color === 'red' || color === 'green') {
    if (meanTex >= 4.2 || color === 'beige' || color === 'gray') return { type: 'knit', formality: 'mid' };
    return { type: 'dress_shirt', formality: 'mid' };
  }
  return { type: 'jacket', formality: 'mid' };
}

export function scanClosetPixels(src: PixelSource, opts: { maxPieces?: number } = {}): ScannedPiece[] {
  const maxPieces = Math.min(16, Math.max(1, opts.maxPieces ?? 12));
  const g = buildGrid(src);
  const { xMin, xMax, rodY, wallLab } = findCabinetBounds(g);

  const upperY1 = Math.min(g.gh - 12, rodY + Math.max(2, Math.round(g.gh * 0.02)));
  const upperMidY2 = Math.floor(g.gh * 0.56);
  const minW = Math.max(8, Math.round((xMax - xMin) * 0.095));
  const maxW = Math.max(minW + 5, Math.round((xMax - xMin) * 0.225));

  // If the left side is a hanging fabric organizer (like Photo 2/3), advance xStart past its vertical border.
  let railStart = xMin;
  const probeRight = Math.min(xMax - minW, xMin + Math.round((xMax - xMin) * 0.28));
  if (isShelfOrganizer(g, xMin, probeRight, upperY1, Math.floor(g.gh * 0.85), wallLab)) {
    railStart = probeRight;
  }

  const upperSpans = segmentBandColumns(g, railStart, xMax, upperY1, upperMidY2, minW, maxW);
  const rawBoxes: Array<{ gx1: number; gy1: number; gx2: number; gy2: number; upper: boolean }> = [];
  const coveredLower = new Uint8Array(g.gw);

  for (const [gx1, gx2] of upperSpans) {
    if (isShelfOrganizer(g, gx1, gx2, upperY1, upperMidY2, wallLab)) continue;
    const upperLab = columnBandLab(g, Math.floor((gx1 + gx2) / 2), upperY1 + 4, upperMidY2 - 4);
    // Check foreground presence: either distinct from wallLab or has knit/fold texture.
    let edgeSum = 0;
    for (let y = upperY1 + 2; y < upperMidY2; y += 2) {
      for (let x = gx1; x <= gx2; x++) edgeSum += g.dx[y * g.gw + x] + g.dy[y * g.gw + x];
    }
    const meanEdge = edgeSum / Math.max(1, ((upperMidY2 - upperY1) / 2) * (gx2 - gx1 + 1));
    if (labDist(upperLab, wallLab) < 9.5 && meanEdge < 3.4) continue;

    // Trace true garment hem downward (coats continue to ~0.88gh; short jackets/knits end around 0.54..0.64gh).
    let gy2 = upperMidY2;
    const maxBottom = Math.floor(g.gh * 0.88);
    for (let y = upperMidY2; y <= maxBottom; y += 2) {
      const rowSamples: Lab[] = [];
      let rowDy = 0;
      for (let x = gx1 + 1; x <= gx2 - 1; x++) {
        rowSamples.push(g.lab[y * g.gw + x]);
        rowDy += g.dy[y * g.gw + x];
      }
      const meanRowDy = rowDy / Math.max(1, gx2 - gx1 - 1);
      const rowLab = medianVec(rowSamples);
      if (labDist(rowLab, upperLab) > 14.5 || meanRowDy > 8.2 || (labDist(rowLab, wallLab) < 8.5 && meanEdge < 4.5)) break;
      gy2 = y;
    }
    rawBoxes.push({ gx1, gy1: upperY1, gx2, gy2, upper: true });
    if (gy2 >= Math.floor(g.gh * 0.72)) {
      for (let x = gx1; x <= gx2; x++) coveredLower[x] = 1;
    }
  }

  // Scan lower hanging zone (y in [0.65..0.95]) across uncovered columns for lower-rod garments.
  const lowY1 = Math.floor(g.gh * 0.65);
  const lowY2 = Math.floor(g.gh * 0.94);
  let lx = railStart;
  while (lx <= xMax - minW && rawBoxes.length < maxPieces) {
    if (coveredLower[lx]) { lx++; continue; }
    let rx = lx;
    while (rx <= xMax && !coveredLower[rx]) rx++;
    if (rx - 1 - lx >= minW) {
      const lowSpans = segmentBandColumns(g, lx, rx - 1, lowY1, lowY2, Math.max(9, Math.round(minW * 1.1)), Math.round(maxW * 1.15));
      for (const [gx1, gx2] of lowSpans) {
        if (rawBoxes.length >= maxPieces) break;
        if (isShelfOrganizer(g, gx1, gx2, lowY1, lowY2, wallLab)) continue;
        const lowLab = columnBandLab(g, Math.floor((gx1 + gx2) / 2), lowY1 + 3, lowY2 - 3);
        if (labDist(lowLab, wallLab) < 15) continue; // skip neutral floor/storage bins
        rawBoxes.push({ gx1, gy1: lowY1, gx2, gy2: lowY2, upper: false });
      }
    }
    lx = rx + 1;
  }

  // Fallback for single-person outfit / centered flat-lay photo if no rack columns matched.
  if (rawBoxes.length === 0) {
    rawBoxes.push(
      { gx1: Math.floor(g.gw * 0.24), gy1: Math.floor(g.gh * 0.14), gx2: Math.floor(g.gw * 0.76), gy2: Math.floor(g.gh * 0.54), upper: true },
      { gx1: Math.floor(g.gw * 0.28), gy1: Math.floor(g.gh * 0.52), gx2: Math.floor(g.gw * 0.72), gy2: Math.floor(g.gh * 0.90), upper: false },
    );
  }

  const pieces: ScannedPiece[] = [];
  for (const b of rawBoxes.slice(0, maxPieces)) {
    const x1 = Math.max(0, Math.min(src.w - 4, Math.round(b.gx1 * g.sx)));
    const y1 = Math.max(0, Math.min(src.h - 4, Math.round(b.gy1 * g.sy)));
    const x2 = Math.max(x1 + 4, Math.min(src.w, Math.round(b.gx2 * g.sx)));
    const y2 = Math.max(y1 + 4, Math.min(src.h, Math.round(b.gy2 * g.sy)));
    const box: PixelBox = { x1, y1, x2, y2 };
    const raster = buildSilhouetteMask(src, box, wallLab, b.upper);
    const measured = maskColor(src, raster);
    const color: ColorFamily = measured === 'unknown' ? 'charcoal' : measured;
    const { type, formality } = classifyGarment(g, b.gx1, b.gy1, b.gx2, b.gy2, color, b.upper);
    const cardId = pieces.length + 1;
    pieces.push({
      cardId,
      slot: GARMENT_TYPES[type],
      type,
      color,
      formality,
      normBox: [
        Math.round((x1 / src.w) * 1000),
        Math.round((y1 / src.h) * 1000),
        Math.round((x2 / src.w) * 1000),
        Math.round((y2 / src.h) * 1000),
      ],
      box,
      mask: { x: raster.x, y: raster.y, w: raster.w, h: raster.h, rle: encodeMockRle(raster.bits) },
    });
  }
  return pieces;
}

/** Measures real silhouette pixels and dominant color inside an owner-drawn normalized [0..1000] box. */
export function scanCustomBox(
  src: PixelSource,
  normBox: [number, number, number, number],
  cardId: number,
  typeHint?: GarmentType,
): ScannedPiece {
  const g = buildGrid(src);
  const { wallLab } = findCabinetBounds(g);
  const clamp = (n: number, hi: number) => Math.max(0, Math.min(hi, Math.round(n)));
  const x1 = clamp((normBox[0] / 1000) * src.w, src.w - 8);
  const y1 = clamp((normBox[1] / 1000) * src.h, src.h - 8);
  const x2 = Math.max(x1 + 8, clamp((normBox[2] / 1000) * src.w, src.w));
  const y2 = Math.max(y1 + 8, clamp((normBox[3] / 1000) * src.h, src.h));
  const box: PixelBox = { x1, y1, x2, y2 };
  const upper = y1 < src.h * 0.55;
  const raster = buildSilhouetteMask(src, box, wallLab, upper);
  const measured = maskColor(src, raster);
  const color: ColorFamily = measured === 'unknown' ? 'charcoal' : measured;
  const gx1 = Math.floor(x1 / g.sx), gy1 = Math.floor(y1 / g.sy);
  const gx2 = Math.ceil(x2 / g.sx), gy2 = Math.ceil(y2 / g.sy);
  const inferred = classifyGarment(g, gx1, gy1, gx2, gy2, color, upper);
  const type = typeHint ?? inferred.type;
  return {
    cardId,
    slot: GARMENT_TYPES[type],
    type,
    color,
    formality: inferred.formality,
    normBox: [
      Math.round((x1 / src.w) * 1000),
      Math.round((y1 / src.h) * 1000),
      Math.round((x2 / src.w) * 1000),
      Math.round((y2 / src.h) * 1000),
    ],
    box,
    mask: { x: raster.x, y: raster.y, w: raster.w, h: raster.h, rle: encodeMockRle(raster.bits) },
  };
}

