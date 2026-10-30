// Spark boxes (0–1000 grid) → original pixels, and the SAM 3.1 box-prompt / output token grammar.
// Grammar from the SAM segmenting and reading-segmentation docs (prompt: <0f>id<|box;...|>,...).

export type NormBox = readonly [number, number, number, number];
export type PixelBox = { x1: number; y1: number; x2: number; y2: number };

export const SAM_MAX_OBJECTS = 16;

/**
 * Convert a 0–1000 box to pixels of the image as sent (w·h after EXIF rotation is baked in).
 * Plan §3-3: integer floor, kept inside the image. x2/y2 are inclusive, as in SAM boxes.
 */
export function normToPixelBox(b: NormBox, w: number, h: number): PixelBox {
  const fx = (v: number) => Math.min(w - 1, Math.max(0, Math.floor((v * w) / 1000)));
  const fy = (v: number) => Math.min(h - 1, Math.max(0, Math.floor((v * h) / 1000)));
  return { x1: fx(b[0]), y1: fy(b[1]), x2: fx(b[2]), y2: fy(b[3]) };
}

export type PromptObject = { id: number; box: PixelBox };

export function buildBoxPrompt(objects: readonly PromptObject[], w: number, h: number): string {
  if (objects.length === 0) throw new Error('no objects');
  if (objects.length > SAM_MAX_OBJECTS) throw new Error(`at most ${SAM_MAX_OBJECTS} prompted objects`);
  const seen = new Set<number>();
  const parts = objects.map((o) => {
    if (!Number.isInteger(o.id) || o.id < 0 || seen.has(o.id)) throw new Error(`bad or repeated object id ${o.id}`);
    seen.add(o.id);
    const { x1, y1, x2, y2 } = o.box;
    for (const v of [x1, y1, x2, y2]) if (!Number.isInteger(v)) throw new Error('box coordinates must be integers');
    if (x1 < 0 || y1 < 0 || x2 >= w || y2 >= h || x1 > x2 || y1 > y2) throw new Error(`box outside the ${w}x${h} frame`);
    return `${o.id}<|box;x1=${x1};y1=${y1};x2=${x2};y2=${y2};w=${w};h=${h}|>`;
  });
  return `<0f>${parts.join(',')}`;
}

export type SamMaskWire = { h: number; w: number; enc: string; payload: string };
export type SamRecordWire = { id: number; box: PixelBox; frameW: number; frameH: number; mask: SamMaskWire | null };

const RECORD_RE =
  /(\d+)<\|box;x1=(\d+);y1=(\d+);x2=(\d+);y2=(\d+);w=(\d+);h=(\d+)(?:;c=[0-9.]+)?\|>(?:<\|mask;x=0;y=0(?:;c=[0-9.]+)?;data=(\d+),(\d+),(.)(.*?)\|>)?/g;

/** Parse frame-0 records of a SAM output string. Records arrive in stream order. */
export function parseSegmentation(text: string): SamRecordWire[] {
  const out: SamRecordWire[] = [];
  const frame0 = text.split(/<(?=\d+f>)/).find((p) => p.startsWith('0f>')) ?? text;
  for (const m of frame0.matchAll(RECORD_RE)) {
    out.push({
      id: Number(m[1]),
      box: { x1: Number(m[2]), y1: Number(m[3]), x2: Number(m[4]), y2: Number(m[5]) },
      frameW: Number(m[6]),
      frameH: Number(m[7]),
      mask: m[8] ? { h: Number(m[8]), w: Number(m[9]), enc: m[10], payload: m[11] } : null,
    });
  }
  return out;
}

/** Binary raster aligned to the record box: h rows × w columns, row-major. */
export type MaskRaster = { x: number; y: number; w: number; h: number; bits: Uint8Array };

/**
 * Mock-only encoding (marker 'R'): run lengths in base 36, separated by '.', alternating 0/1 runs
 * starting with 0. The documented encodings ('~' lossless, '!' one_bit) need the official decoder,
 * which is not installed in this build.
 */
export function encodeMockRle(bits: Uint8Array): string {
  const runs: number[] = [];
  let cur = 0;
  let n = 0;
  for (const b of bits) {
    if (b === cur) n++;
    else {
      runs.push(n);
      cur = b;
      n = 1;
    }
  }
  runs.push(n);
  return runs.map((r) => r.toString(36)).join('.');
}

export function decodeMockRle(payload: string, size: number): Uint8Array {
  const bits = new Uint8Array(size);
  let pos = 0;
  let cur = 0;
  for (const tok of payload.split('.')) {
    const n = parseInt(tok, 36);
    if (!Number.isFinite(n) || n < 0) throw new Error('bad RLE token');
    if (cur === 1) bits.fill(1, pos, pos + n);
    pos += n;
    cur ^= 1;
  }
  if (pos !== size) throw new Error(`RLE covers ${pos} of ${size} pixels`);
  return bits;
}
