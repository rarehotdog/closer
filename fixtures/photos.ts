// Sample outfit photos — code-drawn color-block placeholders (the plan's fallback when image
// generation is blocked, §4-5). Each is flagged 'Sample photo · code-drawn placeholder' and each item
// 'Sample item'. No people, logos or text. Ground truth (manifest) is written here before any call.
// The three Try photos hold the nine FX-H roles split 4·3·2, each item in one photo only.
import type { NormBox } from '../engine/coords.ts';
import { normToPixelBox } from '../engine/coords.ts';
import type { PixelSource, Rgb } from '../engine/color.ts';
import type { Direction, OffenderWhy } from '../shared/wardrobe.ts';
import { HERO_SENTENCE, role } from './fxh.ts';

export const PHOTO_W = 1200;
export const PHOTO_H = 1600;
const BG: Rgb = [234, 231, 224];

export type PhotoGarment = { role: string; box: NormBox };

export type SamplePhoto = {
  photoId: string;
  title: string;
  w: number;
  h: number;
  garments: PhotoGarment[];
  svg: string;
  url: string;
  pixels: PixelSource;
};

export const CHIPS = [
  { chipId: 'c1', text: HERO_SENTENCE },
  { chipId: 'c2', text: 'Keep this top. Make the rest a bit more relaxed.' },
  { chipId: 'c3', text: 'Keep this top. It feels too casual for dinner.' },
] as const;

/** Test-only sentence for AT-29 (ambiguous reference). */
export const AMBIGUOUS_SENTENCE = '그거 말고 다른 거';

type Truth = { pin: number[]; direction: Direction; offenders: { index: number; why: OffenderWhy }[] };

const LAYOUT: Record<string, { title: string; garments: PhotoGarment[]; truth: Record<string, Truth> }> = {
  p1: {
    title: 'Outfit 1 · 4 items',
    garments: [
      { role: 'J1', box: [80, 60, 480, 520] },
      { role: 'T1', box: [540, 60, 920, 470] },
      { role: 'B1', box: [120, 560, 480, 960] },
      { role: 'S1', box: [560, 640, 900, 900] },
    ],
    truth: {
      [CHIPS[0].text]: { pin: [0], direction: 'less_formal', offenders: [{ index: 2, why: 'too_formal' }, { index: 3, why: 'too_formal' }] },
      [CHIPS[1].text]: { pin: [1], direction: 'less_formal', offenders: [{ index: 2, why: 'too_formal' }, { index: 3, why: 'too_formal' }] },
      [CHIPS[2].text]: { pin: [1], direction: 'more_formal', offenders: [] },
      [AMBIGUOUS_SENTENCE]: { pin: [], direction: 'none', offenders: [] },
    },
  },
  p2: {
    title: 'Outfit 2 · 3 items',
    garments: [
      { role: 'T2', box: [100, 80, 520, 520] },
      { role: 'B3', box: [580, 80, 900, 640] },
      { role: 'S2', box: [180, 660, 820, 900] },
    ],
    truth: {
      [CHIPS[0].text]: { pin: [], direction: 'less_formal', offenders: [] },
      [CHIPS[1].text]: { pin: [0], direction: 'less_formal', offenders: [{ index: 1, why: 'too_formal' }] },
      [CHIPS[2].text]: { pin: [0], direction: 'more_formal', offenders: [{ index: 2, why: 'too_casual' }] },
    },
  },
  p3: {
    title: 'Outfit 3 · 2 items',
    garments: [
      { role: 'T3', box: [120, 100, 880, 460] },
      { role: 'B2', box: [280, 520, 720, 960] },
    ],
    truth: {
      [CHIPS[0].text]: { pin: [], direction: 'less_formal', offenders: [] },
      [CHIPS[1].text]: { pin: [0], direction: 'less_formal', offenders: [] },
      [CHIPS[2].text]: { pin: [0], direction: 'more_formal', offenders: [{ index: 1, why: 'too_casual' }] },
    },
  },
};

/** Chamfered rectangle in pixel space — the garment silhouette used by both the SVG and the pixels. */
export function garmentShape(box: NormBox, w = PHOTO_W, h = PHOTO_H) {
  const p = normToPixelBox(box, w, h);
  const c = Math.floor(0.12 * Math.min(p.x2 - p.x1 + 1, p.y2 - p.y1 + 1));
  const inside = (x: number, y: number) =>
    x >= p.x1 && x <= p.x2 && y >= p.y1 && y <= p.y2 &&
    x - p.x1 + (y - p.y1) >= c && p.x2 - x + (y - p.y1) >= c && x - p.x1 + (p.y2 - y) >= c && p.x2 - x + (p.y2 - y) >= c;
  const poly: [number, number][] = [
    [p.x1 + c, p.y1], [p.x2 - c, p.y1], [p.x2, p.y1 + c], [p.x2, p.y2 - c],
    [p.x2 - c, p.y2], [p.x1 + c, p.y2], [p.x1, p.y2 - c], [p.x1, p.y1 + c],
  ];
  return { pixelBox: p, inside, poly };
}

function noise(x: number, y: number): number {
  return ((Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0) % 13 - 6;
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function buildPhoto(photoId: string): SamplePhoto {
  const L = LAYOUT[photoId];
  const shapes = L.garments.map((g) => ({ g, rgb: role(g.role).rgb, ...garmentShape(g.box) }));
  const pixels: PixelSource = {
    w: PHOTO_W,
    h: PHOTO_H,
    rgbAt(x, y) {
      const n = noise(x, y);
      for (const s of shapes) if (s.inside(x, y)) return [clamp(s.rgb[0] + n), clamp(s.rgb[1] + n), clamp(s.rgb[2] + n)];
      return [clamp(BG[0] + n), clamp(BG[1] + n), clamp(BG[2] + n)];
    },
  };
  const polys = shapes
    .map((s) => `<polygon points="${s.poly.map(([x, y]) => `${x},${y}`).join(' ')}" fill="rgb(${s.rgb.join(',')})" stroke="rgba(0,0,0,0.18)" stroke-width="3"/>`)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PHOTO_W} ${PHOTO_H}" width="${PHOTO_W}" height="${PHOTO_H}"><rect width="${PHOTO_W}" height="${PHOTO_H}" fill="rgb(${BG.join(',')})"/>${polys}</svg>`;
  const url = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
  return { photoId, title: L.title, w: PHOTO_W, h: PHOTO_H, garments: L.garments, svg, url, pixels };
}

export type PhotoLibrary = {
  list(): SamplePhoto[];
  get(photoId: string): SamplePhoto | null;
  byUrl(url: string): SamplePhoto | null;
};

export function createPhotoLibrary(): PhotoLibrary {
  const photos = Object.keys(LAYOUT).map(buildPhoto);
  return {
    list: () => photos,
    get: (id) => photos.find((p) => p.photoId === id) ?? null,
    byUrl: (url) => photos.find((p) => p.url === url) ?? null,
  };
}

/** Ground truth for the mock Spark 1 (written before any call). */
export function spark1Truth(photoId: string, sentence: string) {
  const L = LAYOUT[photoId];
  if (!L) return null;
  const t = L.truth[sentence];
  if (!t) return null;
  return {
    garments: L.garments.map((g) => {
      const r = role(g.role);
      return { box: [...g.box] as [number, number, number, number], type: r.type, color_family: r.color, formality: r.formality };
    }),
    pin: [...t.pin],
    direction: t.direction,
    offenders: t.offenders.map((o) => ({ ...o })),
    reasonCandidates: [...new Set(t.offenders.map((o) => o.why))],
  };
}

/** Roles not in a photo: the sample wardrobe seeded next to it (F2: 'Sample wardrobe · n items seeded'). */
export function rolesOutside(photoId: string): string[] {
  const inPhoto = new Set(LAYOUT[photoId].garments.map((g) => g.role));
  return ['J1', 'T1', 'T2', 'T3', 'B1', 'B2', 'B3', 'S1', 'S2'].filter((r) => !inPhoto.has(r));
}
