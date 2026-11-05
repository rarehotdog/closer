// Trimmed copy of closer engine/validate.ts at dba9ff3 (github.com/rarehotdog/closer): only what photo -> cards needs.
// Code re-checks of every model output (§3-3 "코드가 다시 보는 것"). Well-formed JSON is not proof
// that IDs exist, that rules hold, or that anything was saved (§3-5).
import { mergeCodes, type ReasonCode } from '../shared/reasons.ts';
import {
  DIRECTIONS, FORMALITY_LEVELS, GARMENT_TYPES, OFFENDER_WHY, SLOTS,
  isColorFamily, isGarmentType,
  type ColorFamily, type Direction, type Formality, type GarmentType, type OffenderWhy, type Slot,
} from '../shared/wardrobe.ts';
import { SAM_MAX_OBJECTS, type MaskRaster, type PixelBox, type PromptObject } from './coords.ts';

export type Fail = { ok: false; codes: ReasonCode[]; detail: string };

// ---------- Spark 1 ----------
export type Spark1Garment = { box: [number, number, number, number]; type: GarmentType; color_family: ColorFamily; formality: Formality };
export type Spark1Output = {
  garments: Spark1Garment[];
  pin: number[];
  direction: Direction;
  offenders: { index: number; why: OffenderWhy }[];
  reasonCandidates: OffenderWhy[];
};

const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);
const fail = (codes: ReasonCode[], detail: string): Fail => ({ ok: false, codes, detail });

export function validateSpark1(raw: unknown): { ok: true; value: Spark1Output } | Fail {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || !Array.isArray(o.garments)) return fail(['INVALID_MODEL_OUTPUT'], 'garments missing');
  const g = o.garments as unknown[];
  if (g.length > SAM_MAX_OBJECTS) return fail(['TOO_MANY_ITEMS'], `${g.length} garments > ${SAM_MAX_OBJECTS}`);
  if (g.length === 0) return fail(['INVALID_MODEL_OUTPUT'], 'no garments');
  const slotsSeen: Slot[] = [];
  for (const [i, x] of g.entries()) {
    const it = x as Record<string, unknown>;
    const b = it?.box as unknown[];
    if (!Array.isArray(b) || b.length !== 4 || !b.every((v) => isInt(v) && v >= 0 && v <= 1000)) return fail(['INVALID_MODEL_OUTPUT'], `garment ${i}: box`);
    if ((b[0] as number) >= (b[2] as number) || (b[1] as number) >= (b[3] as number)) return fail(['INVALID_MODEL_OUTPUT'], `garment ${i}: empty box`);
    if (!isGarmentType(it.type)) return fail(['INVALID_MODEL_OUTPUT'], `garment ${i}: type`);
    if (!isColorFamily(it.color_family)) return fail(['INVALID_MODEL_OUTPUT'], `garment ${i}: color_family`);
    if (!(FORMALITY_LEVELS as readonly unknown[]).includes(it.formality)) return fail(['INVALID_MODEL_OUTPUT'], `garment ${i}: formality`);
    const slot = GARMENT_TYPES[it.type];
    if (slotsSeen.includes(slot)) return fail(['INVALID_MODEL_OUTPUT'], `slot rule: two garments in ${slot}`);
    slotsSeen.push(slot);
  }
  const inRange = (v: unknown) => isInt(v) && v >= 0 && v < g.length;
  if (!Array.isArray(o.pin) || !o.pin.every(inRange) || new Set(o.pin).size !== o.pin.length) return fail(['INVALID_MODEL_OUTPUT'], 'pin indices');
  if (!(DIRECTIONS as readonly unknown[]).includes(o.direction)) return fail(['INVALID_MODEL_OUTPUT'], 'direction');
  if (!Array.isArray(o.offenders)) return fail(['INVALID_MODEL_OUTPUT'], 'offenders');
  for (const off of o.offenders as Record<string, unknown>[]) {
    if (!inRange(off?.index) || !(OFFENDER_WHY as readonly unknown[]).includes(off?.why)) return fail(['INVALID_MODEL_OUTPUT'], 'offender entry');
  }
  const rc = Array.isArray(o.reasonCandidates) ? o.reasonCandidates : [];
  if (!rc.every((r) => (OFFENDER_WHY as readonly unknown[]).includes(r))) return fail(['INVALID_MODEL_OUTPUT'], 'reasonCandidates');
  const value = { garments: g, pin: o.pin, direction: o.direction, offenders: o.offenders, reasonCandidates: rc } as Spark1Output;
  const pinSet = new Set(value.pin);
  if (value.offenders.some((x) => pinSet.has(x.index))) return fail(['PIN_CONFLICT'], 'an offender is also the item to keep');
  return { ok: true, value };
}

// ---------- SAM ----------
export type SamRecord = { id: number; box: PixelBox; frameW: number; frameH: number; raster: MaskRaster | null };

/** Records as code accepted them (an overshooting box clamped to its prompt box) plus one note per clamp. */
export type SamCheck = { ok: true; records: SamRecord[]; notes: string[] } | Fail;

/**
 * Default mask-in-box tolerance: max(8 px, 5 % of the longer side of the prompted box). The docs'
 * own example lands 1–4 px outside its prompt box (docs/status.md §4-12), so 0 would hold every run.
 */
export function autoMaskTolerancePx(box: PixelBox): number {
  const side = Math.max(box.x2 - box.x1 + 1, box.y2 - box.y1 + 1);
  return Math.max(8, Math.ceil(side * 0.05));
}

/** CLOSER_MASK_TOLERANCE_PX: a fixed tolerance in whole pixels. Unset, empty or unusable → the per-box default. */
export function maskToleranceFromEnv(env: Record<string, string | undefined>): number | undefined {
  const raw = (env.CLOSER_MASK_TOLERANCE_PX ?? '').trim();
  if (raw === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** The part of a raster that lies inside `box` (box must be inside the raster's own box). */
function cropRaster(r: MaskRaster, box: PixelBox): MaskRaster {
  const w = box.x2 - box.x1 + 1;
  const h = box.y2 - box.y1 + 1;
  const bits = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const from = (box.y1 - r.y + y) * r.w + (box.x1 - r.x);
    bits.set(r.bits.subarray(from, from + w), y * w);
  }
  return { x: box.x1, y: box.y1, w, h, bits };
}

/**
 * Response ID set = request ID set; sent w·h = image size; raster size = returned box size; the
 * returned box inside the prompted box within the tolerance (undefined/null → autoMaskTolerancePx
 * per box). A box that overshoots within the tolerance is clamped to the prompt box, its raster
 * cropped, and noted as 'mask N overshoot X px' instead of holding the decision.
 */
export function validateSam(objects: readonly PromptObject[], records: readonly SamRecord[], w: number, h: number, tolerancePx?: number | null): SamCheck {
  const req = objects.map((o) => o.id).sort((a, b) => a - b).join(',');
  const res = records.map((r) => r.id).sort((a, b) => a - b).join(',');
  if (req !== res) return fail(['INVALID_MODEL_OUTPUT'], `SAM ids {${res}} != requested {${req}}`);
  const out: SamRecord[] = [];
  const notes: string[] = [];
  for (const r of records) {
    if (r.frameW !== w || r.frameH !== h) return fail(['INVALID_MODEL_OUTPUT'], `SAM frame ${r.frameW}x${r.frameH} != ${w}x${h}`);
    const p = objects.find((o) => o.id === r.id)!.box;
    if (r.raster && (r.raster.w !== r.box.x2 - r.box.x1 + 1 || r.raster.h !== r.box.y2 - r.box.y1 + 1)) {
      return fail(['INVALID_MODEL_OUTPUT'], `mask ${r.id} raster size != box size`);
    }
    const over = Math.max(0, p.x1 - r.box.x1, p.y1 - r.box.y1, r.box.x2 - p.x2, r.box.y2 - p.y2);
    const t = tolerancePx ?? autoMaskTolerancePx(p);
    if (over > t) return fail(['INVALID_MODEL_OUTPUT'], `mask ${r.id} leaves its box by ${over} px (tolerance ${t})`);
    if (over === 0) {
      out.push(r);
      continue;
    }
    const box: PixelBox = { x1: Math.max(r.box.x1, p.x1), y1: Math.max(r.box.y1, p.y1), x2: Math.min(r.box.x2, p.x2), y2: Math.min(r.box.y2, p.y2) };
    if (box.x1 > box.x2 || box.y1 > box.y2) return fail(['INVALID_MODEL_OUTPUT'], `mask ${r.id} lies outside its box`);
    out.push({ ...r, box, raster: r.raster ? cropRaster(r.raster, box) : null });
    notes.push(`mask ${r.id} overshoot ${over} px`);
  }
  return { ok: true, records: out, notes };
}
