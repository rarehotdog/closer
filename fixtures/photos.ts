// Sample outfit photos — code-drawn color-block placeholders (the plan's fallback when image
// generation is blocked, §4-5). Each is flagged 'Sample photo · code-drawn placeholder' and each item
// 'Sample item'. No people, logos or text. Ground truth (manifest) is written here before any call.
// The three Try photos hold the nine FX-H roles split 4·3·2, each item in one photo only.
// Each photo is one PNG data URL (the image API accepts png, jpeg, gif and webp, not SVG), encoded
// once per process from the same shade() the pixel source reads, so the bytes the models see are
// the pixels code measures.
import type { NormBox, PixelBox } from '../engine/coords.ts';
import { normToPixelBox } from '../engine/coords.ts';
import type { PixelSource, Rgb } from '../engine/color.ts';
import { encodePng } from '../engine/png.ts';
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
  /** PNG data URL, 1200 × 1600. */
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

/** Chamfered rectangle in pixel space — the garment silhouette used by both the PNG and the pixels. */
export function garmentShape(box: NormBox, w = PHOTO_W, h = PHOTO_H) {
  const p = normToPixelBox(box, w, h);
  const c = Math.floor(0.12 * Math.min(p.x2 - p.x1 + 1, p.y2 - p.y1 + 1));
  const k = Math.SQRT1_2;
  /** Signed distance (px) from the silhouette's edge: ≥ 0 inside (0 on the edge), < 0 outside. */
  const slack = (x: number, y: number) =>
    Math.min(
      x - p.x1, p.x2 - x, y - p.y1, p.y2 - y,
      (x - p.x1 + (y - p.y1) - c) * k, (p.x2 - x + (y - p.y1) - c) * k, (x - p.x1 + (p.y2 - y) - c) * k, (p.x2 - x + (p.y2 - y) - c) * k,
    );
  const inside = (x: number, y: number) => slack(x, y) >= 0;
  return { pixelBox: p, inside, slack };
}

type Shape = { rgb: Rgb; pixelBox: PixelBox; slack(x: number, y: number): number };

/** A 3 px outline (1.5 px to each side of the edge) darkened by 18%, so a white shirt stays visible on the background. */
const OUTLINE_PX = 1.5;
const OUTLINE_SHADE = 0.82;

/** Colour of one pixel: the first garment holding it, else the background; the outline band is darkened. */
function shade(shapes: Shape[], x: number, y: number): Rgb {
  let base: Rgb = BG;
  let edge = false;
  for (const s of shapes) {
    const d = s.slack(x, y);
    if (d >= 0) {
      base = s.rgb;
      edge = d < OUTLINE_PX;
      break;
    }
    if (d > -OUTLINE_PX) edge = true;
  }
  return edge ? [Math.round(base[0] * OUTLINE_SHADE), Math.round(base[1] * OUTLINE_SHADE), Math.round(base[2] * OUTLINE_SHADE)] : base;
}

/** photoId → PNG data URL. The layout is fixed, so each photo is encoded once per process (about 0.1 s each) and shared by every library. */
const PNG_URLS = new Map<string, string>();

function rasterize(photoId: string, shapes: Shape[], w: number, h: number): string {
  const cached = PNG_URLS.get(photoId);
  if (cached) return cached;
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = BG[0]; data[i + 1] = BG[1]; data[i + 2] = BG[2]; data[i + 3] = 255;
  }
  // Only pixels within 2 px of a garment box can differ from the background (the outline band is 1.5 px wide).
  for (const s of shapes) {
    const x1 = Math.max(0, s.pixelBox.x1 - 2), x2 = Math.min(w - 1, s.pixelBox.x2 + 2);
    const y1 = Math.max(0, s.pixelBox.y1 - 2), y2 = Math.min(h - 1, s.pixelBox.y2 + 2);
    for (let y = y1; y <= y2; y++) {
      for (let x = x1; x <= x2; x++) {
        const [r, g, b] = shade(shapes, x, y);
        const i = (y * w + x) * 4;
        data[i] = r; data[i + 1] = g; data[i + 2] = b;
      }
    }
  }
  const url = `data:image/png;base64,${encodePng({ w, h, data }).toString('base64')}`;
  PNG_URLS.set(photoId, url);
  return url;
}

function buildPhoto(photoId: string): SamplePhoto {
  const L = LAYOUT[photoId];
  const shapes: Shape[] = L.garments.map((g) => ({ rgb: role(g.role).rgb, ...garmentShape(g.box) }));
  const pixels: PixelSource = { w: PHOTO_W, h: PHOTO_H, rgbAt: (x, y) => shade(shapes, x, y) };
  return { photoId, title: L.title, w: PHOTO_W, h: PHOTO_H, garments: L.garments, url: rasterize(photoId, shapes, PHOTO_W, PHOTO_H), pixels };
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
