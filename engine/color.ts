// Mask color re-measure (§3-3 SAM row): median Lab of mask pixels → nearest of 12 named colors.
import { COLOR_FAMILIES, type ColorFamily } from '../shared/wardrobe.ts';
import type { MaskRaster } from './coords.ts';

export type Rgb = readonly [number, number, number];
export type Lab = readonly [number, number, number];
export type PixelSource = { w: number; h: number; rgbAt(x: number, y: number): Rgb };

/** Reference sRGB per named color [가정 — tune with SP-B2 photos]. */
export const NAMED_RGB: Record<(typeof COLOR_FAMILIES)[number], Rgb> = {
  black: [20, 20, 22],
  charcoal: [58, 60, 66],
  gray: [128, 128, 130],
  white: [240, 240, 236],
  beige: [212, 194, 160],
  brown: [112, 76, 50],
  navy: [30, 40, 82],
  blue: [44, 92, 170],
  green: [62, 122, 72],
  red: [180, 42, 46],
  yellow: [226, 196, 62],
  pink: [232, 162, 182],
};

function lin(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function rgbToLab([r, g, b]: Rgb): Lab {
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const NAMED_LAB = COLOR_FAMILIES.map((name) => ({ name, lab: rgbToLab(NAMED_RGB[name]) }));

export function nearestColor(lab: Lab): ColorFamily {
  let best: ColorFamily = 'unknown';
  let bestD = Infinity;
  for (const n of NAMED_LAB) {
    const d = (lab[0] - n.lab[0]) ** 2 + (lab[1] - n.lab[1]) ** 2 + (lab[2] - n.lab[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = n.name;
    }
  }
  return best;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Channel-wise median Lab over mask pixels (sampled every `stride` pixels in x and y). */
export function maskMedianLab(src: PixelSource, mask: MaskRaster, stride = 4): Lab | null {
  const L: number[] = [], A: number[] = [], B: number[] = [];
  for (let yy = 0; yy < mask.h; yy += stride) {
    for (let xx = 0; xx < mask.w; xx += stride) {
      if (!mask.bits[yy * mask.w + xx]) continue;
      const x = mask.x + xx, y = mask.y + yy;
      if (x < 0 || y < 0 || x >= src.w || y >= src.h) continue;
      const lab = rgbToLab(src.rgbAt(x, y));
      L.push(lab[0]);
      A.push(lab[1]);
      B.push(lab[2]);
    }
  }
  if (L.length === 0) return null;
  return [median(L), median(A), median(B)];
}

export function maskColor(src: PixelSource, mask: MaskRaster): ColorFamily {
  const lab = maskMedianLab(src, mask);
  return lab ? nearestColor(lab) : 'unknown';
}
