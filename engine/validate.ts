// Code re-checks of every model output (§3-3 "코드가 다시 보는 것"). Well-formed JSON is not proof
// that IDs exist, that rules hold, or that anything was saved (§3-5).
import { mergeCodes, type ReasonCode } from '../shared/reasons.ts';
import type { IsoDate } from '../shared/dates.ts';
import {
  DIRECTIONS, FORMALITY_LEVELS, GARMENT_TYPES, OFFENDER_WHY, SLOTS,
  isColorFamily, isGarmentType,
  type ColorFamily, type DecisionContext, type Direction, type Formality, type GarmentType, type OffenderWhy, type Outfit, type Slot,
} from '../shared/wardrobe.ts';
import { SAM_MAX_OBJECTS, type MaskRaster, type PixelBox, type PromptObject } from './coords.ts';
import { checkOutfit, type RuleSet, type WardrobeFacts } from './rules.ts';
import type { SolverInput } from './solver.ts';

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

/** Response ID set = request ID set; sent w·h = image size; mask inside the prompted box (± tolerance). */
export function validateSam(objects: readonly PromptObject[], records: readonly SamRecord[], w: number, h: number, tolerancePx = 0): { ok: true } | Fail {
  const req = objects.map((o) => o.id).sort((a, b) => a - b).join(',');
  const res = records.map((r) => r.id).sort((a, b) => a - b).join(',');
  if (req !== res) return fail(['INVALID_MODEL_OUTPUT'], `SAM ids {${res}} != requested {${req}}`);
  for (const r of records) {
    if (r.frameW !== w || r.frameH !== h) return fail(['INVALID_MODEL_OUTPUT'], `SAM frame ${r.frameW}x${r.frameH} != ${w}x${h}`);
    const p = objects.find((o) => o.id === r.id)!.box;
    const t = tolerancePx;
    if (r.box.x1 < p.x1 - t || r.box.y1 < p.y1 - t || r.box.x2 > p.x2 + t || r.box.y2 > p.y2 + t) {
      return fail(['INVALID_MODEL_OUTPUT'], `mask ${r.id} leaves its box`);
    }
    if (r.raster && (r.raster.w !== r.box.x2 - r.box.x1 + 1 || r.raster.h !== r.box.y2 - r.box.y1 + 1)) {
      return fail(['INVALID_MODEL_OUTPUT'], `mask ${r.id} raster size != box size`);
    }
  }
  return { ok: true };
}

// ---------- Spark 2 ----------
export type Spark2Raw = { kind: 'function_call'; name: string; arguments: string } | { kind: 'text'; text: string };

export const ASK_CODES: readonly ReasonCode[] = ['ATTR_UNKNOWN', 'PIN_CONFLICT', 'NO_VALID_COMBO', 'AMBIGUOUS_REFERENCE'];

export type ValidOption = { outfit: Outfit; changedSlots: Slot[]; reasonFactIds: string[]; visualMatch: string[] };

export type Spark2Check =
  | { ok: true; kind: 'options'; options: ValidOption[] }
  | { ok: true; kind: 'ask'; code: ReasonCode; itemIds: string[] }
  | (Fail & { perOption: ReasonCode[][] });

export type Spark2CheckContext = {
  ctx: DecisionContext;
  facts: WardrobeFacts;
  today: IsoDate;
  rules: RuleSet;
  input: SolverInput;
  factIds: readonly string[];
};

export function validateSpark2(raw: Spark2Raw, c: Spark2CheckContext): Spark2Check {
  const bad = (codes: ReasonCode[], detail: string, perOption: ReasonCode[][] = []) => ({ ok: false as const, codes, detail, perOption });
  if (raw.kind === 'text') return bad(['NO_ACTION'], 'text reply instead of a tool call');
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(raw.arguments) as Record<string, unknown>;
  } catch {
    return bad(['INVALID_MODEL_OUTPUT'], 'arguments are not JSON');
  }
  if (raw.name === 'ask_owner') {
    const code = args.questionCode as ReasonCode;
    const ids = args.itemIds as unknown[];
    if (!ASK_CODES.includes(code)) return bad(['INVALID_MODEL_OUTPUT'], 'questionCode not allowed');
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && c.facts.items.has(id))) return bad(['INVALID_MODEL_OUTPUT'], 'ask_owner itemIds');
    if (code === 'AMBIGUOUS_REFERENCE' && ids.length < 2) return bad(['INVALID_MODEL_OUTPUT'], 'ambiguous reference needs 2+ candidates');
    return { ok: true, kind: 'ask', code, itemIds: ids as string[] };
  }
  if (raw.name !== 'propose_edit') return bad(['INVALID_MODEL_OUTPUT'], `unknown tool ${raw.name}`);
  const opts = args.options as unknown[];
  if (!Array.isArray(opts) || opts.length < 1 || opts.length > 2) return bad(['INVALID_MODEL_OUTPUT'], 'options must be 1–2');
  const enums = new Map(c.input.slots.map((sp) => [sp.slot, new Set(sp.ranked.map((r) => r.itemId))]));
  const perOption: ReasonCode[][] = [];
  const valid: ValidOption[] = [];
  for (const o of opts as Record<string, unknown>[]) {
    const codes: ReasonCode[] = [];
    const outfit: Outfit = { ...c.input.current };
    const changes = o?.changes as Record<string, unknown>[];
    const seen = new Set<string>();
    if (!Array.isArray(changes)) codes.push('INVALID_MODEL_OUTPUT');
    else {
      for (const ch of changes) {
        const slot = ch?.slot as Slot;
        const id = ch?.itemId;
        if (!(SLOTS as readonly unknown[]).includes(slot) || typeof id !== 'string' || seen.has(slot)) {
          codes.push('INVALID_MODEL_OUTPUT');
          continue;
        }
        seen.add(slot);
        if (!enums.get(slot)?.has(id)) codes.push('INVALID_MODEL_OUTPUT'); // not in the candidate enum code sent
        outfit[slot] = id;
      }
    }
    const rf = o?.reasonFactIds;
    if (!Array.isArray(rf) || !rf.every((f) => typeof f === 'string' && c.factIds.includes(f))) codes.push('INVALID_MODEL_OUTPUT');
    const vm = Array.isArray(o?.visual_match) ? (o.visual_match as Record<string, unknown>[]) : [];
    const vmIds = vm.map((v) => v?.itemId);
    if (!vmIds.every((id) => typeof id === 'string' && Object.values(outfit).includes(id))) codes.push('INVALID_MODEL_OUTPUT');
    const ruleCodes = checkOutfit(outfit, c.ctx, c.facts, c.today, c.rules, { current: c.input.current, forced: c.input.forced, baselineSum: c.input.baselineSum });
    const all = mergeCodes(codes, ruleCodes);
    perOption.push(all);
    if (all.length === 0) {
      valid.push({
        outfit,
        changedSlots: SLOTS.filter((s) => outfit[s] !== c.input.current[s]),
        reasonFactIds: rf as string[],
        visualMatch: vmIds as string[],
      });
    }
  }
  if (valid.length === 2 && JSON.stringify(valid[0].outfit) === JSON.stringify(valid[1].outfit)) {
    perOption[1] = mergeCodes(perOption[1], ['INVALID_MODEL_OUTPUT']);
  }
  const anyBad = perOption.some((p) => p.length > 0);
  if (anyBad) {
    // Conservative: one bad option rejects the whole output (correction once, then HOLD).
    return bad(mergeCodes(...perOption), 'option(s) failed code checks', perOption);
  }
  return { ok: true, kind: 'options', options: valid };
}
