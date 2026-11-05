// One photo (+ one sentence) -> garment cards, through Meta's models with closer's code checks.
// Spark (muse-spark-1.3) proposes one box per garment, the piece to keep, the direction and the
// pieces that feel off; SAM (sam-3.1) returns one mask per box; code checks both answers, measures
// each garment's colour from its mask pixels and cuts it out. Nothing here saves anything: the
// browser shows the cards and the owner confirms them.
import type { Transport } from './closer/adapters/transport.ts';
import type { CallDeps } from './closer/adapters/responses.ts';
import type { CallDraft } from './closer/adapters/types.ts';
import { createSpark1Port } from './closer/adapters/spark1.ts';
import { readCloset, validateCloset } from './closetSpark.ts';
import { createSamPort } from './closer/adapters/sam.ts';
import { officialMaskDecoder } from './closer/adapters/samDecoder.ts';
import { validateSam, validateSpark1 } from './closer/engine/validate.ts';
import { buildBoxPrompt, encodeMockRle, normToPixelBox, type PixelBox } from './closer/engine/coords.ts';
import { maskColor, type PixelSource } from './closer/engine/color.ts';
import { cutoutPng } from './closer/engine/thumbs.ts';
import { decodePng, isPng, jpegSize } from './closer/engine/png.ts';
import { scaledPixels, stripJpegMetadata } from './closer/store/photos.ts';
import { GARMENT_TYPES, type ColorFamily, type Direction, type Formality, type GarmentType, type OffenderWhy } from './closer/shared/wardrobe.ts';
import type { ReasonCode } from './closer/shared/reasons.ts';

export const MAX_LONG_SIDE = 1600;
export const MAX_JPEG_BYTES = 6 * 1024 * 1024;
export const MAX_SENTENCE = 200;

/** mode 'outfit' (default): one worn outfit + a sentence. 'closet': a closet, rail or clothes laid out, up to 16 garments. */
export type ScanInput = { jpegBase64: unknown; pngBase64: unknown; sentence: unknown; mode?: unknown };
export type ScanKind = 'outfit' | 'closet';

export type ScanCard = {
  cardId: number;
  slot: string;
  type: GarmentType;
  /** What Spark said. */
  sparkColor: ColorFamily;
  /** What the mask pixels say (null when there is no mask). */
  maskColor: ColorFamily | null;
  formality: Formality;
  box: PixelBox;
  pinned: boolean;
  offender: OffenderWhy | null;
  /** Set when Spark's colour and the mask pixels disagree: the owner picks before confirming. */
  colorChoices: [ColorFamily, ColorFamily] | null;
  /** PNG cut-out (mask) or box crop, long side 256 px, as a data URL. */
  cutout: string;
  cutoutKind: 'mask' | 'box_crop';
};

export type CallLine = { model: string; http: number; latencyMs: number; source: 'live' | 'mock' | 'cached'; costMicroUsd: number };

export type ScanOk = {
  ok: true;
  cards: ScanCard[];
  kind: ScanKind;
  direction: Direction;
  /** Closet mode: Spark said the photo shows garments it did not list (null in outfit mode). */
  moreNotListed: boolean | null;
  samMode: 'mask' | 'box_crop';
  /** Plain lines shown under the cards: refusals, clamps, parser notes. */
  notes: string[];
  calls: CallLine[];
  w: number;
  h: number;
};
export type ScanFail = { ok: false; status: number; code: ReasonCode | 'BAD_INPUT'; detail: string; calls: CallLine[] };

export type ScanDeps = {
  transport: Transport;
  source: 'live' | 'mock';
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
  nowIso?: () => string;
  maskTolerancePx?: number | null;
};

const lines = (calls: CallDraft[]): CallLine[] => calls.map((c) => ({ model: c.model, http: c.http, latencyMs: c.latencyMs, source: c.source, costMicroUsd: c.costMicroUsd }));
const bad = (detail: string): ScanFail => ({ ok: false, status: 400, code: 'BAD_INPUT', detail, calls: [] });

function b64(x: unknown, what: string): Buffer | string {
  if (typeof x !== 'string' || x.length === 0) return `${what} is missing`;
  const s = x.replace(/^data:[^,]*,/, '');
  if (!/^[A-Za-z0-9+/=\s]+$/.test(s)) return `${what} is not base64`;
  return Buffer.from(s, 'base64');
}

/** Full-box raster for a box crop (SAM unavailable or its masks refused). */
function boxRaster(b: PixelBox) {
  const w = b.x2 - b.x1 + 1, h = b.y2 - b.y1 + 1;
  return { x: b.x1, y: b.y1, w, h, rle: encodeMockRle(new Uint8Array(w * h).fill(1)) };
}

const pngUrl = (pixels: PixelSource, m: { x: number; y: number; w: number; h: number; rle: string }) => `data:image/png;base64,${cutoutPng(pixels, m).toString('base64')}`;

export async function scanPhoto(input: ScanInput, deps: ScanDeps): Promise<ScanOk | ScanFail> {
  // ---- inputs: checked before any call ----
  const jpeg0 = b64(input.jpegBase64, 'jpegBase64');
  if (typeof jpeg0 === 'string') return bad(jpeg0);
  const png0 = b64(input.pngBase64, 'pngBase64');
  if (typeof png0 === 'string') return bad(png0);
  if (jpeg0.length > MAX_JPEG_BYTES) return bad('photo over 6 MB');
  const sentence = typeof input.sentence === 'string' ? input.sentence.trim() : '';
  if (sentence.length > MAX_SENTENCE) return bad(`sentence over ${MAX_SENTENCE} characters (not sent)`);
  const jpeg = stripJpegMetadata(jpeg0);
  const size = jpegSize(jpeg);
  if (!size) return bad('jpegBase64 is not a JPEG');
  if (Math.max(size.w, size.h) > MAX_LONG_SIDE) return bad(`long side over ${MAX_LONG_SIDE} px`);
  if (!isPng(png0)) return bad('pngBase64 is not a PNG');
  let pixels: PixelSource;
  try {
    pixels = scaledPixels(decodePng(png0), size.w, size.h);
  } catch (e) {
    return bad(`PNG copy could not be read: ${e instanceof Error ? e.message : String(e)}`);
  }
  const { w, h } = size;
  const imageUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;

  const d: CallDeps = {
    transport: deps.transport,
    source: deps.source,
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    nowMs: deps.nowMs ?? (() => Date.now()),
    nowIso: deps.nowIso ?? (() => new Date().toISOString()),
  };
  const calls: CallDraft[] = [];

  // ---- Spark: boxes, kept piece, direction, pieces that feel off ----
  if (input.mode !== undefined && input.mode !== 'outfit' && input.mode !== 'closet') return bad("mode must be 'outfit' or 'closet'");
  const kind: ScanKind = input.mode === 'closet' ? 'closet' : 'outfit';
  let s1: { garments: { box: readonly [number, number, number, number]; type: GarmentType; color_family: ColorFamily; formality: Formality }[]; pin: number[]; direction: Direction; offenders: { index: number; why: OffenderWhy }[] };
  let moreNotListed: boolean | null = null;
  if (kind === 'closet') {
    const rc = await readCloset(d, imageUrl);
    calls.push(...rc.calls);
    if (!rc.ok) return { ok: false, status: 502, code: rc.code, detail: rc.detail, calls: lines(calls) };
    const vc = validateCloset(rc.value);
    if (!vc.ok) return { ok: false, status: 422, code: vc.codes[0] ?? 'INVALID_MODEL_OUTPUT', detail: `Spark's answer failed the code check: ${vc.detail}`, calls: lines(calls) };
    s1 = { garments: vc.value.garments, pin: [], direction: 'none', offenders: [] };
    moreNotListed = vc.value.moreNotListed;
  } else {
    const r1 = await createSpark1Port(d).perceive({ imageUrl, sentence: sentence || 'Find each garment in this photo.' });
    calls.push(...r1.calls);
    if (!r1.ok) return { ok: false, status: 502, code: r1.code, detail: r1.detail, calls: lines(calls) };
    const v1 = validateSpark1(r1.value);
    if (!v1.ok) return { ok: false, status: 422, code: v1.codes[0] ?? 'INVALID_MODEL_OUTPUT', detail: `Spark's answer failed the code check: ${v1.detail}`, calls: lines(calls) };
    s1 = v1.value;
  }
  const objects = s1.garments.map((g, i) => ({ id: i + 1, box: normToPixelBox(g.box, w, h) }));

  // ---- SAM: one mask per box ----
  const notes: string[] = [];
  let samMode: 'mask' | 'box_crop' = 'mask';
  const rasters = new Map<number, { x: number; y: number; w: number; h: number; rle: string; bits: Uint8Array }>();
  const rs = await createSamPort({ ...d, decodeMask: officialMaskDecoder }).segment({ imageUrl, prompt: buildBoxPrompt(objects, w, h) });
  calls.push(...rs.calls);
  if (!rs.ok) {
    samMode = 'box_crop';
    notes.push(`SAM did not return usable masks (${rs.code}: ${rs.detail}). Showing box crops; colours not measured from pixels.`);
  } else {
    const vs = validateSam(objects, rs.value, w, h, deps.maskTolerancePx ?? null);
    if (!vs.ok) {
      // closer holds the whole photo here. This app checks each mask on its own instead: masks that
      // pass are used, the refused ones fall back to Spark's box crop, and the note names each refusal.
      const refused: string[] = [];
      for (const o of objects) {
        const rec = rs.value.filter((r) => r.id === o.id);
        if (rec.length !== 1) {
          refused.push(`mask ${o.id}: ${rec.length === 0 ? 'none returned' : 'returned twice'}`);
          continue;
        }
        const one = validateSam([o], rec, w, h, deps.maskTolerancePx ?? null);
        if (!one.ok) {
          refused.push(one.detail);
          continue;
        }
        notes.push(...one.notes);
        const r = one.records[0];
        if (r.raster) rasters.set(r.id, { x: r.raster.x, y: r.raster.y, w: r.raster.w, h: r.raster.h, rle: encodeMockRle(r.raster.bits), bits: r.raster.bits });
      }
      if (rasters.size === 0) {
        samMode = 'box_crop';
        notes.push(`SAM masks refused by the code check (${vs.detail}). Showing box crops; colours not measured from pixels.`);
      } else {
        notes.push(...(rs.notes ?? []));
        notes.push(`${refused.length} of ${objects.length} masks refused by the code check (${refused.join('; ')}): those cards show box crops, colours not measured.`);
      }
    } else {
      notes.push(...(rs.notes ?? []), ...vs.notes);
      for (const r of vs.records) if (r.raster) rasters.set(r.id, { x: r.raster.x, y: r.raster.y, w: r.raster.w, h: r.raster.h, rle: encodeMockRle(r.raster.bits), bits: r.raster.bits });
    }
  }

  const pin = new Set(s1.pin);
  const off = new Map(s1.offenders.map((o) => [o.index, o.why] as const));
  const cards: ScanCard[] = s1.garments.map((g, i) => {
    const id = i + 1;
    const r = samMode === 'mask' ? rasters.get(id) : undefined;
    const mc = r ? maskColor(pixels, r) : null;
    const cut = r ? { x: r.x, y: r.y, w: r.w, h: r.h, rle: r.rle } : boxRaster(objects[i].box);
    return {
      cardId: id,
      slot: GARMENT_TYPES[g.type],
      type: g.type,
      sparkColor: g.color_family,
      maskColor: mc,
      formality: g.formality,
      box: objects[i].box,
      pinned: pin.has(i),
      offender: off.get(i) ?? null,
      colorChoices: mc !== null && mc !== g.color_family ? [g.color_family, mc] : null,
      cutout: pngUrl(pixels, cut),
      cutoutKind: r ? 'mask' : 'box_crop',
    };
  });
  if (moreNotListed) notes.push('Spark says the photo shows more garments than it listed (at most 16 per photo). Take a second photo for the rest.');
  return { ok: true, kind, cards, direction: s1.direction, moreNotListed, samMode, notes, calls: lines(calls), w, h };
}
