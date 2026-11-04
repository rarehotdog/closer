// Decision service: photo → Spark 1 → code (pixel boxes) → SAM → code (mask colors) → owner confirm
// → code (candidates, unknowns, feasibility) → Spark 2 → code checks → owner pick → commit.
// Code decides IDs, rules, transitions, idempotency, caps, labels, commits (§3-5). Model calls are
// outside DB transactions. `now` and `today` are injected (§3-6).
import { randomUUID } from 'node:crypto';
import { mergeCodes, type ReasonCode } from '../shared/reasons.ts';
import type { Actor, PlanState, WorkspaceKind } from '../shared/states.ts';
import type { Decision, EventInput, ItemRow, LedgerState, Mutation, PlanRow, WorkspaceRow, WriteResponse, CallRow } from '../shared/ledger.ts';
import { kstDateOf, type IsoDate } from '../shared/dates.ts';
import {
  DIRECTIONS, GARMENT_TYPES, SLOTS, SLOT_ID_PREFIX,
  type ColorFamily, type DecisionContext, type Direction, type Formality, type GarmentType, type HardRule, type Item, type Outfit, type Slot,
} from '../shared/wardrobe.ts';
import { LABELS, callPanel, changedOnly, keepTarget, liveChip, offendersChip, sampleWardrobe, confirmedWearsSince } from '../shared/labels.ts';
import type { SqliteLedger, StoredOperation } from '../store/ledger.ts';
import { stateHashOf } from '../store/ledger.ts';
import type { CallDraft, Ports, Spark2Request } from '../adapters/types.ts';
import { EST_MICRO_USD } from '../adapters/responses.ts';
import { WONDER_EST_MICRO_USD, type WonderRequest, type WonderResult } from '../adapters/wonder.ts';
import { checkHumanAction, checkTransition } from './stateMachine.ts';
import { ALL_RULES, factsFromState, formalitySum, pinHardConflict, withFormality, type RuleSet, type WardrobeFacts } from './rules.ts';
import { buildSolverInput, chooseOptions, type SolverInput } from './solver.ts';
import { decisiveUnknown } from './unknowns.ts';
import { buildFacts, pickReasonFacts, renderReasons } from './facts.ts';
import { validateSam, validateSpark1, validateSpark2, type Spark2Check } from './validate.ts';
import { buildBoxPrompt, encodeMockRle, normToPixelBox, type PixelBox } from './coords.ts';
import { maskColor, type PixelSource } from './color.ts';
import { gateModelCall } from './caps.ts';
import { planAnchor } from './anchor.ts';
import { cutoutPng, MAX_THUMBNAILS } from './thumbs.ts';
import { checkIntent, INTENT_CHIPS } from './intent.ts';

export type Clock = { now(): Date; today(): IsoDate };

export type PhotoSource = {
  get(photoId: string): { photoId: string; w: number; h: number; url: string; pixels: PixelSource } | null;
};

/**
 * Public copies — visitor forks and the sample closets — share the visitor money caps on every model
 * path and, in real mode, fixed sentences only. store/ledger.ts spend() sums the same rows.
 */
export function isPublicCopy(ws: Pick<WorkspaceRow, 'kind' | 'seedRef'>): boolean {
  return ws.kind === 'visitor' || ws.seedRef === 'sample-closet';
}

export type Question = {
  code: ReasonCode;
  itemIds: string[];
  cardId: number | null;
  attr: 'color' | 'formality' | null;
  choices: string[];
  text: string;
};

export type Card = {
  cardId: number;
  slot: Slot;
  type: GarmentType;
  sparkColor: ColorFamily;
  maskColor: ColorFamily | null;
  formality: Formality;
  normBox: [number, number, number, number];
  box: PixelBox;
  mask: { x: number; y: number; w: number; h: number; rle: string } | null;
  arrival: number | null;
  pinned: boolean;
  offender: boolean;
  question: Question | null;
};

export type OptionView = {
  index: number;
  label: 'Fewer changes' | 'Closer to what you said' | 'A gentler step' | 'Re-plan' | 'Keep as is';
  outfit: Outfit;
  changedSlots: Slot[];
  sum: number | null;
  reasonFactIds: string[];
  reasonLines: string[];
  source: 'model' | 'code';
};

export type Operation = StoredOperation & {
  operationId: string;
  workspaceId: string;
  generation: number;
  kind: 'photo' | 'next' | 'replan' | 'anchor';
  state: PlanState;
  baseRevision: number;
  planId: string;
  occasionDate: IsoDate;
  sessionId: string | null;
  photoId: string | null;
  sentence: string | null;
  hardRules: HardRule[];
  weather: { rainPct: number } | null;
  perception: { pin: number[]; direction: string; offenders: { index: number; why: string }[]; samMode: 'mask' | 'box_crop' | null; w: number; h: number } | null;
  cards: Card[];
  cardItemIds: Record<string, string>;
  confirmEvents: EventInput[] | null;
  context: DecisionContext | null;
  options: OptionView[];
  questions: Question[];
  reasonCodes: ReasonCode[];
  exclusions: { itemId: string; codes: ReasonCode[] }[];
  rejections: { attempt: number; codes: ReasonCode[]; detail: string; perOption: ReasonCode[][] }[];
  callIds: string[];
  callLines: string[];
  liveChips: string[];
  modelCalls: number;
  staleResponses: number;
  labels: string[];
  /** Sentence path (feature 1): what code accepted from the intent reader. */
  intent?: { anchors: string[]; direction: Direction; rain: boolean };
  detail: string;
  /** Owner answers to ATTR_UNKNOWN formality questions; applied to this decision only. */
  formalityAnswers: Record<string, Formality>;
};

export type ServiceDeps = {
  ledger: SqliteLedger;
  ports: Ports;
  clock: Clock;
  photos: PhotoSource;
  mode: 'mock' | 'real';
  rules?: RuleSet;
  /** 'code' = G3 cut #5: code solver options + 'Reason by code' label, no Spark 2 call. */
  spark2Mode?: 'model' | 'code';
  maskTolerancePx?: number;
};

type Who = { eventId: string; actor: Actor; expectedRevision: number };

const ASK_TEXT = {
  ambiguous: (ids: string[]) => `Which one do you mean: ${ids.join(' or ')}?`,
};

export class CloserService {
  readonly ledger: SqliteLedger;
  readonly ports: Ports;
  readonly clock: Clock;
  readonly photos: PhotoSource;
  readonly mode: 'mock' | 'real';
  readonly rules: RuleSet;
  readonly spark2Mode: 'model' | 'code';
  /** null: per-box default (engine/validate.ts autoMaskTolerancePx); a number: CLOSER_MASK_TOLERANCE_PX. */
  readonly maskTolerancePx: number | null;

  constructor(d: ServiceDeps) {
    this.ledger = d.ledger;
    this.ports = d.ports;
    this.clock = d.clock;
    this.photos = d.photos;
    this.mode = d.mode;
    this.rules = d.rules ?? ALL_RULES;
    this.spark2Mode = d.spark2Mode ?? 'model';
    this.maskTolerancePx = d.maskTolerancePx ?? null;
  }

  // ---------------- operations ----------------
  getOperation(operationId: string): Operation | null {
    return this.ledger.getOperation(operationId) as Operation | null;
  }

  private save(op: Operation): Operation {
    this.ledger.saveOperation(op, this.clock.now().toISOString());
    return op;
  }

  private newOp(ws: WorkspaceRow, kind: Operation['kind'], extra: Partial<Operation> = {}): Operation {
    const t = checkTransition('NONE', 'DRAFT', 'system', ws.kind); // row 1
    if (!t.ok) throw new Error(t.detail);
    return {
      operationId: `op_${randomUUID()}`,
      workspaceId: ws.workspaceId,
      generation: 1,
      kind,
      state: 'DRAFT',
      baseRevision: ws.ledgerRevision,
      planId: `plan_${randomUUID().slice(0, 12)}`,
      occasionDate: this.clock.today(),
      sessionId: null,
      photoId: null,
      sentence: null,
      hardRules: [],
      weather: null,
      perception: null,
      cards: [],
      cardItemIds: {},
      confirmEvents: null,
      context: null,
      options: [],
      questions: [],
      reasonCodes: [],
      exclusions: [],
      rejections: [],
      callIds: [],
      callLines: [],
      liveChips: [],
      modelCalls: 0,
      staleResponses: 0,
      labels: [],
      detail: '',
      formalityAnswers: {},
      ...extra,
    };
  }

  private hold(op: Operation, kind: WorkspaceKind, codes: ReasonCode[], question: Question | null = null, detail = ''): Operation {
    const t = checkTransition(op.state, 'HOLD', 'system', kind); // row 3
    if (!t.ok) throw new Error(`cannot hold from ${op.state}: ${t.detail}`);
    op.state = 'HOLD';
    op.reasonCodes = mergeCodes(op.reasonCodes, codes);
    op.questions = question ? [question] : [];
    op.detail = detail;
    return this.save(op);
  }

  private recordCalls(op: Operation, calls: CallDraft[]): void {
    for (const c of calls) {
      const row: CallRow = { ...c, operationId: op.operationId, workspaceId: op.workspaceId, sessionId: op.sessionId };
      this.ledger.insertCall(row);
      op.callIds.push(c.callId);
      op.callLines.push(callPanel(c));
      const chip = liveChip(c);
      if (chip) op.liveChips.push(chip);
      op.modelCalls++;
    }
  }

  private noteLastCall(op: Operation, notes: readonly string[]): void {
    if (notes.length === 0 || op.callLines.length === 0) return;
    op.callLines[op.callLines.length - 1] += ` · ${notes.join(' · ')}`;
  }

  private gate(ws: WorkspaceRow, sessionId: string | null, est: number) {
    const flags = this.ledger.getFlags();
    const now = this.clock.now();
    const spend = this.ledger.spend({ sessionId, kstDate: kstDateOf(now) });
    return gateModelCall({ now, kill: flags.kill, caps: flags.caps, spend, isVisitor: isPublicCopy(ws), estMicroUsd: this.mode === 'real' ? est : 0 });
  }

  private ws(workspaceId: string): WorkspaceRow {
    const ws = this.ledger.getWorkspace(workspaceId);
    if (!ws) throw new Error(`unknown workspace ${workspaceId}`);
    return ws;
  }

  // ---------------- step 1: photo + sentence ----------------
  async startPhoto(
    workspaceId: string,
    a: { photoId: string; sentence: string; sessionId?: string | null; hardRules?: HardRule[]; weather?: { rainPct: number } | null },
  ): Promise<Operation | { ok: false; code: ReasonCode; detail: string }> {
    const ws = this.ws(workspaceId);
    if (ws.publicReadOnly) return { ok: false, code: 'SCOPE_DENIED', detail: 'read-only workspace' };
    const op = this.newOp(ws, 'photo', { sessionId: a.sessionId ?? null, photoId: a.photoId, sentence: a.sentence, hardRules: a.hardRules ?? [], weather: a.weather ?? null });
    op.labels.push(LABELS.ledgerZeroUntilConfirm);
    const g1 = this.gate(ws, op.sessionId, EST_MICRO_USD.spark1 + EST_MICRO_USD.sam);
    if (!g1.ok) return this.hold(op, ws.kind, [g1.code], null, g1.detail);
    const photo = this.photos.get(a.photoId);
    if (!photo || Math.max(photo.w, photo.h) > 1600) return this.hold(op, ws.kind, ['UNSUPPORTED_IMAGE'], null, 'photo missing or long side over 1,600 px');
    if (a.sentence.length > 200) return this.hold(op, ws.kind, ['META_REQUEST_REJECTED'], null, 'sentence over 200 characters (not sent)');

    const r1 = await this.ports.spark1.perceive({ imageUrl: photo.url, sentence: a.sentence });
    this.recordCalls(op, r1.calls);
    if (!r1.ok) return this.hold(op, ws.kind, [r1.code], null, r1.detail);
    const v1 = validateSpark1(r1.value);
    if (!v1.ok) return this.hold(op, ws.kind, v1.codes, null, v1.detail);
    const s1 = v1.value;

    const objects = s1.garments.map((g, i) => ({ id: i + 1, box: normToPixelBox(g.box, photo.w, photo.h) }));
    const prompt = buildBoxPrompt(objects, photo.w, photo.h);
    const g2 = this.gate(ws, op.sessionId, EST_MICRO_USD.sam);
    if (!g2.ok) return this.hold(op, ws.kind, [g2.code], null, g2.detail);
    const rs = await this.ports.sam.segment({ imageUrl: photo.url, prompt });
    this.recordCalls(op, rs.calls);
    let samMode: 'mask' | 'box_crop' = 'mask';
    const arrival = new Map<number, number>();
    const rasters = new Map<number, NonNullable<Card['mask']> & { bits: Uint8Array }>();
    if (!rs.ok) {
      if (rs.http === 404) {
        samMode = 'box_crop'; // §3-3: 404 → box crops, no mask color check
        op.labels.push(LABELS.boxCropsOnly);
      } else return this.hold(op, ws.kind, [rs.code], null, rs.detail);
    } else {
      const parserNotes = rs.notes ?? [];
      this.noteLastCall(op, parserNotes); // parser diagnostics on the SAM call line
      const vs = validateSam(objects, rs.value, photo.w, photo.h, this.maskTolerancePx);
      if (!vs.ok) return this.hold(op, ws.kind, vs.codes, null, [vs.detail, ...parserNotes].join(' · '));
      this.noteLastCall(op, vs.notes); // 'mask N overshoot X px': clamped, not held
      vs.records.forEach((r, i) => {
        arrival.set(r.id, i);
        if (r.raster) rasters.set(r.id, { x: r.raster.x, y: r.raster.y, w: r.raster.w, h: r.raster.h, rle: encodeMockRle(r.raster.bits), bits: r.raster.bits });
      });
    }

    const pin = new Set(s1.pin);
    const offenders = new Set(s1.offenders.map((o) => o.index));
    op.cards = s1.garments.map((g, i): Card => {
      const id = i + 1;
      const r = rasters.get(id);
      const mc = samMode === 'mask' && r ? maskColor(photo.pixels, r) : null;
      const q: Question | null =
        mc !== null && mc !== g.color_family
          ? { code: 'ATTR_UNKNOWN', itemIds: [], cardId: id, attr: 'color', choices: [g.color_family, mc], text: `Card ${id}: is it ${g.color_family} or ${mc}?` }
          : null;
      return {
        cardId: id,
        slot: GARMENT_TYPES[g.type],
        type: g.type,
        sparkColor: g.color_family,
        maskColor: mc,
        formality: g.formality,
        normBox: g.box,
        box: objects[i].box,
        mask: r ? { x: r.x, y: r.y, w: r.w, h: r.h, rle: r.rle } : null,
        arrival: arrival.get(id) ?? null,
        pinned: pin.has(i),
        offender: offenders.has(i),
        question: q,
      };
    });
    op.perception = { pin: s1.pin, direction: s1.direction, offenders: s1.offenders, samMode, w: photo.w, h: photo.h };
    op.questions = op.cards.filter((c) => c.question).map((c) => c.question!);
    const pinnedTypes = op.cards.filter((c) => c.pinned).map((c) => c.type);
    if (pinnedTypes.length) op.labels.push(keepTarget(pinnedTypes));
    const offSlots = op.cards.filter((c) => c.offender).map((c) => c.slot);
    if (offSlots.length) op.labels.push(offendersChip(offSlots));
    return this.save(op);
  }

  // ---------------- step 2: owner confirms cards ----------------
  confirmCards(
    workspaceId: string,
    a: Omit<Who, 'eventId'> & { operationId: string; eventIds: string[]; answers?: Record<string, { color?: ColorFamily; formality?: Formality }> },
  ): WriteResponse {
    const op = this.getOperation(a.operationId);
    if (!op || op.workspaceId !== workspaceId || op.kind !== 'photo') return { ok: false, code: 'INVALID_TRANSITION', detail: 'no such photo operation' };
    if (op.confirmEvents) {
      // Retry of the same confirm: resend the identical events (same eventIds, same payloads).
      return this.ledger.write({ workspaceId, expectedRevision: a.expectedRevision, events: op.confirmEvents }, () => ({ ok: false, code: 'STALE_STATE', detail: 'already confirmed' }), this.clock.now().toISOString());
    }
    if (op.state !== 'DRAFT' || op.cards.length === 0) return { ok: false, code: 'INVALID_TRANSITION', detail: `operation is ${op.state}` };
    if (a.eventIds.length !== op.cards.length) return { ok: false, code: 'INVALID_TRANSITION', detail: 'one eventId per card' };
    for (const c of op.cards) {
      const ans = a.answers?.[String(c.cardId)];
      if (c.question && !ans?.color) return { ok: false, code: 'ATTR_UNKNOWN', detail: `card ${c.cardId} has an open question` };
    }
    const today = this.clock.today();
    const state = this.ledger.readState(workspaceId, { fresh: false });
    const taken = new Set(state.items.map((i) => i.itemId));
    const items: ItemRow[] = op.cards.map((c) => {
      const prefix = SLOT_ID_PREFIX[c.slot];
      let n = 1;
      while (taken.has(`${prefix}${n}`)) n++;
      const itemId = `${prefix}${n}`;
      taken.add(itemId);
      const ans = a.answers?.[String(c.cardId)];
      return {
        itemId, slot: c.slot, type: c.type, color: ans?.color ?? c.sparkColor, formality: ans?.formality ?? c.formality,
        ownership: 'CONFIRMED', cutoutRef: `${op.operationId}#${c.cardId}`, origin: 'photo', waterproof: null, sample: true,
      };
    });
    const events: EventInput[] = items.map((it, i) => ({
      eventId: a.eventIds[i], kind: 'REGISTRATION_CONFIRMED', actor: a.actor, occurredAt: today, correctsEventId: null,
      payload: { operationId: op.operationId, cardId: op.cards[i].cardId, item: it },
    }));
    const res = this.ledger.write(
      { workspaceId, expectedRevision: a.expectedRevision, events },
      (st, wsRow): Decision => {
        const deny = checkHumanAction(a.actor, wsRow.kind, 'registration confirm');
        if (deny && !deny.ok) return { ok: false, code: deny.code, detail: deny.detail };
        if (items.some((it) => st.items.some((x) => x.itemId === it.itemId))) return { ok: false, code: 'STALE_STATE', detail: 'item id taken' };
        const muts: Mutation[] = items.flatMap((it): Mutation[] => [{ op: 'putItem', item: it }, { op: 'putAvailability', row: { itemId: it.itemId, state: 'AVAILABLE', since: today } }]);
        return { ok: true, mutations: muts, result: { itemIds: items.map((i) => i.itemId) } };
      },
      this.clock.now().toISOString(),
    );
    if (res.ok) {
      op.confirmEvents = events;
      op.cards.forEach((c, i) => (op.cardItemIds[String(c.cardId)] = items[i].itemId));
      op.questions = [];
      const id = (idx: number) => op.cardItemIds[String(idx + 1)];
      const baseline: Outfit = {};
      op.cards.forEach((c, i) => (baseline[c.slot] = items[i].itemId));
      op.context = {
        baseline,
        pinned: op.perception!.pin.map(id),
        direction: op.perception!.direction as DecisionContext['direction'],
        offenders: op.perception!.offenders.map((o) => ({ itemId: id(o.index), why: o.why as DecisionContext['offenders'][number]['why'] })),
        hardRules: op.hardRules,
        weather: op.weather,
      };
      this.save(op);
    }
    return res;
  }

  // ---------------- step 3: proposals ----------------
  async propose(workspaceId: string, a: { operationId: string }): Promise<Operation | { ok: false; code: ReasonCode; detail: string }> {
    const ws = this.ws(workspaceId);
    const found = this.getOperation(a.operationId);
    if (!found || found.workspaceId !== workspaceId) return { ok: false, code: 'INVALID_TRANSITION', detail: 'no such operation' };
    let op: Operation = found;
    if (op.state !== 'DRAFT' || !op.context) return { ok: false, code: 'INVALID_TRANSITION', detail: `operation is ${op.state}${op.context ? '' : ' without confirmed items'}` };
    const ctx = op.context;
    const today = this.clock.today();
    const state = this.ledger.readState(workspaceId, { fresh: false });
    const facts = withFormality(factsFromState(state), new Map(Object.entries(op.formalityAnswers ?? {})));

    const pc = pinHardConflict(ctx, facts, today, this.rules);
    if (pc) {
      const rain = ctx.weather ? ` and rain is ${ctx.weather.rainPct}%` : '';
      return this.hold(op, ws.kind, ['PIN_CONFLICT'], { code: 'PIN_CONFLICT', itemIds: [pc.itemId], cardId: null, attr: null, choices: ['keep', 'switch'], text: `${pc.itemId} breaks your rule${rain}. Keep ${pc.itemId} anyway, or switch it?` });
    }
    const input = buildSolverInput(ctx, facts, today, this.rules);
    op.exclusions = input.slots.flatMap((s) => s.excluded);
    const du = decisiveUnknown(ctx, facts, today, this.rules);
    if (du) {
      return this.hold(op, ws.kind, ['ATTR_UNKNOWN'], { code: 'ATTR_UNKNOWN', itemIds: [du], cardId: null, attr: 'formality', choices: ['low', 'mid', 'high'], text: `How formal is ${du}?` });
    }
    const co = chooseOptions(input);
    if (co.options.length === 0) return this.hold(op, ws.kind, ['NO_VALID_COMBO'], this.relaxQuestion(ctx, co.directionOnlyMisses));

    const allFacts = buildFacts(ctx, facts, today);
    const factIds = allFacts.map((f) => f.id);
    if (this.spark2Mode === 'code') {
      op.options = co.options.map((o, i) => this.optionView(i, o.outfit, o.changedSlots, o.sum, pickReasonFacts(factIds, o.changes, ctx.direction), allFacts, 'code'));
      op.labels.push(LABELS.reasonByCode);
      return this.propose_(op, ws.kind);
    }
    const g = this.gate(ws, op.sessionId, EST_MICRO_USD.spark2);
    if (!g.ok) return this.hold(op, ws.kind, [g.code], null, g.detail);

    const req: Spark2Request = {
      facts: {
        solver: input,
        factIds,
        factLines: allFacts,
        items: [...facts.items.values()].map((it) => ({
          itemId: it.itemId, slot: it.slot, type: it.type, color: it.color, formality: it.formality,
          availability: facts.availability.get(it.itemId) ?? 'AVAILABLE', lastWorn: facts.lastWorn.get(it.itemId) ?? null,
        })),
        pinned: ctx.pinned,
        offenders: ctx.offenders,
        direction: ctx.direction,
      },
      thumbnails: this.thumbnailsFor([...ctx.pinned, ...input.slots.flatMap((sl) => sl.ranked.map((r) => r.itemId))], state),
      correction: null,
    };
    const check = { ctx, facts, today, rules: this.rules, input, factIds };

    let verdict: Spark2Check | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const gen = op.generation;
      const r = await this.ports.spark2.propose(req);
      const fresh: Operation = this.getOperation(op.operationId)!;
      fresh.callIds = op.callIds;
      fresh.callLines = op.callLines;
      fresh.liveChips = op.liveChips;
      fresh.modelCalls = op.modelCalls;
      fresh.rejections = op.rejections;
      fresh.exclusions = op.exclusions;
      op = fresh;
      this.recordCalls(op, r.calls);
      if (op.state === 'CANCELLED' || op.generation !== gen) {
        // Row 11: responses arriving after cancel are discarded.
        op.staleResponses++;
        op.reasonCodes = mergeCodes(op.reasonCodes, ['STALE_RESPONSE']);
        op.options = [];
        this.save(op);
        return { ok: false, code: 'STALE_RESPONSE', detail: `response for generation ${gen} discarded` };
      }
      if (!r.ok) return this.hold(op, ws.kind, [r.code], null, r.detail);
      verdict = validateSpark2(r.value, check);
      if (verdict.ok) break;
      op.rejections.push({ attempt, codes: verdict.codes, detail: verdict.detail, perOption: verdict.perOption });
      this.save(op);
      req.correction = { rejectedCodes: verdict.codes, detail: verdict.detail }; // fresh input, no previous_response_id
    }
    if (!verdict || !verdict.ok) {
      const codes = verdict && !verdict.ok ? verdict.codes : [];
      return this.hold(op, ws.kind, mergeCodes(['INVALID_MODEL_OUTPUT'], codes), null, 'Spark 2 output failed code checks twice (one correction)');
    }
    if (verdict.kind === 'ask') {
      const q: Question = {
        code: verdict.code, itemIds: verdict.itemIds, cardId: null, attr: null, choices: verdict.itemIds,
        text: verdict.code === 'AMBIGUOUS_REFERENCE' ? ASK_TEXT.ambiguous(verdict.itemIds) : verdict.code === 'NO_VALID_COMBO' ? this.relaxQuestion(ctx, co.directionOnlyMisses).text : `Please check ${verdict.itemIds.join(', ')}.`,
      };
      return this.hold(op, ws.kind, [verdict.code], q);
    }
    const opts = [...verdict.options].sort((x, y) => x.changedSlots.length - y.changedSlots.length);
    op.options = opts.map((o, i) => this.optionView(i, o.outfit, o.changedSlots, formalitySum(o.outfit, facts), o.reasonFactIds, allFacts, 'model'));
    op.labels.push(ctx.offenders.length > 0 ? LABELS.checkedByCode : LABELS.checkedByCodeDirection);
    return this.propose_(op, ws.kind);
  }

  private propose_(op: Operation, kind: WorkspaceKind): Operation {
    const t = checkTransition(op.state, 'PROPOSED', 'system', kind); // row 2 (or 7 for re-plans)
    if (!t.ok) throw new Error(t.detail);
    op.state = 'PROPOSED';
    return this.save(op);
  }

  /**
   * Mask cut-outs of items registered from a photo (cutoutRef = operationId#cardId). Items seeded
   * without a photo have none. At most MAX_THUMBNAILS, pinned items first.
   */
  thumbnailsFor(itemIds: string[], state: LedgerState): { itemId: string; imageUrl: string }[] {
    const out: { itemId: string; imageUrl: string }[] = [];
    for (const id of [...new Set(itemIds)]) {
      if (out.length >= MAX_THUMBNAILS) break;
      const ref = state.items.find((i) => i.itemId === id)?.cutoutRef;
      if (!ref) continue;
      const [opId, cardId] = ref.split('#');
      const src = this.getOperation(opId);
      const card = src?.cards.find((c) => String(c.cardId) === cardId);
      const photo = src?.photoId ? this.photos.get(src.photoId) : null;
      if (!card?.mask || !photo) continue;
      out.push({ itemId: id, imageUrl: `data:image/png;base64,${cutoutPng(photo.pixels, card.mask).toString('base64')}` });
    }
    return out;
  }

  private optionView(i: number, outfit: Outfit, changed: Slot[], sum: number | null, reasonFactIds: string[], all: ReturnType<typeof buildFacts>, source: 'model' | 'code'): OptionView {
    return {
      index: i, label: i === 0 ? 'Fewer changes' : 'Closer to what you said', outfit, changedSlots: changed, sum,
      reasonFactIds, reasonLines: renderReasons(reasonFactIds, all), source,
    };
  }

  private relaxQuestion(ctx: DecisionContext, misses: string[]): Question {
    if (misses.length === 1 && (ctx.direction === 'less_formal' || ctx.direction === 'more_formal')) {
      const id = misses[0];
      const more = ctx.direction === 'less_formal' ? 'more formal' : 'more casual';
      return { code: 'NO_VALID_COMBO', itemIds: [id], cardId: null, attr: null, choices: ['keep', 'skip'], text: `Keep ${id} (${more}) or skip?` };
    }
    return { code: 'NO_VALID_COMBO', itemIds: misses, cardId: null, attr: null, choices: ['relax', 'skip'], text: 'Nothing you own fits that request. Relax it or skip?' };
  }

  // ---------------- owner answers (row 4) / cancel (row 11) ----------------
  answer(workspaceId: string, a: { operationId: string; actor: Actor; formality?: Record<string, Formality> }): Operation | { ok: false; code: ReasonCode; detail: string } {
    const ws = this.ws(workspaceId);
    const op = this.getOperation(a.operationId);
    if (!op) return { ok: false, code: 'INVALID_TRANSITION', detail: 'no such operation' };
    const t = checkTransition(op.state, 'DRAFT', a.actor, ws.kind);
    if (!t.ok) return { ok: false, code: t.code, detail: t.detail };
    op.state = 'DRAFT';
    op.questions = [];
    op.reasonCodes = [];
    if (a.formality) op.formalityAnswers = { ...(op.formalityAnswers ?? {}), ...a.formality };
    return this.save(op);
  }

  cancel(workspaceId: string, a: { operationId: string; actor: Actor }): Operation | { ok: false; code: ReasonCode; detail: string } {
    const ws = this.ws(workspaceId);
    const op = this.getOperation(a.operationId);
    if (!op || op.workspaceId !== workspaceId) return { ok: false, code: 'INVALID_TRANSITION', detail: 'no such operation' };
    const t = checkTransition(op.state, 'CANCELLED', a.actor, ws.kind);
    if (!t.ok) return { ok: false, code: t.code, detail: t.detail };
    op.state = 'CANCELLED';
    op.generation++;
    op.options = [];
    return this.save(op);
  }

  // ---------------- step 4: owner picks (row 5) ----------------
  lock(workspaceId: string, a: Who & { operationId: string; optionIndex: number }): WriteResponse {
    const op = this.getOperation(a.operationId);
    if (!op || op.workspaceId !== workspaceId || !op.context) return { ok: false, code: 'INVALID_TRANSITION', detail: 'no such operation' };
    const option = op.options[a.optionIndex];
    const ctx = op.context;
    const today = this.clock.today();
    const ev: EventInput = {
      eventId: a.eventId, kind: 'PLAN_LOCKED', actor: a.actor, occurredAt: today, correctsEventId: null,
      payload: { planId: op.planId, operationId: op.operationId, optionIndex: a.optionIndex, slots: option?.outfit ?? null },
    };
    const res = this.ledger.write(
      { workspaceId, expectedRevision: a.expectedRevision, events: [ev] },
      (st, wsRow): Decision => {
        if (!option) return { ok: false, code: 'INVALID_TRANSITION', detail: 'no such option' };
        const t = checkTransition(op.state, 'LOCKED', a.actor, wsRow.kind);
        if (!t.ok) return { ok: false, code: t.code, detail: t.detail };
        const f = factsFromState(st);
        for (const id of Object.values(option.outfit)) {
          if (!id || !f.items.has(id) || (f.availability.get(id) ?? 'AVAILABLE') !== 'AVAILABLE') return { ok: false, code: 'STALE_STATE', detail: `${id} is no longer available` };
        }
        const plan: PlanRow = { planId: op.planId, occasionDate: op.occasionDate, state: 'LOCKED', slots: option.outfit, pinned: ctx.pinned, context: ctx, baseRevision: a.expectedRevision };
        return { ok: true, mutations: [{ op: 'putPlan', plan }], result: { planId: op.planId, slots: option.outfit } };
      },
      this.clock.now().toISOString(),
    );
    if (res.ok && op.state !== 'LOCKED') {
      op.state = 'LOCKED';
      op.labels = op.labels.filter((l) => l !== LABELS.ledgerZeroUntilConfirm);
      this.save(op);
    }
    return res;
  }

  /** '그대로 입기' — a separate button (AT-20): row 4 (if HOLD) → row 2 with the baseline as its single option → row 5. */
  keepAsIs(workspaceId: string, a: Who & { operationId: string }): WriteResponse {
    const ws = this.ws(workspaceId);
    const op = this.getOperation(a.operationId);
    if (!op || !op.context) return { ok: false, code: 'INVALID_TRANSITION', detail: 'no decision to keep' };
    if (op.state === 'HOLD') {
      const t = checkTransition('HOLD', 'DRAFT', a.actor, ws.kind);
      if (!t.ok) return { ok: false, code: t.code, detail: t.detail };
      op.state = 'DRAFT';
    }
    if (op.state === 'DRAFT') {
      const t = checkTransition('DRAFT', 'PROPOSED', 'system', ws.kind);
      if (!t.ok) return { ok: false, code: t.code, detail: t.detail };
      op.state = 'PROPOSED';
    }
    const facts = factsFromState(this.ledger.readState(workspaceId, { fresh: false }));
    op.options = [{ index: 0, label: 'Keep as is', outfit: op.context.baseline, changedSlots: [], sum: formalitySum(op.context.baseline, facts), reasonFactIds: [], reasonLines: ['You chose to keep the outfit as it is'], source: 'code' }];
    this.save(op);
    return this.lock(workspaceId, { ...a, optionIndex: 0 });
  }

  // ---------------- step 5: availability button (rows 13 → 6 → 7) ----------------
  setAvailability(workspaceId: string, a: Who & { itemId: string; state: 'AVAILABLE' | 'LAUNDRY' | 'REPAIR' | 'STORED' }): WriteResponse & { replans?: Operation[] } {
    const today = this.clock.today();
    const ev: EventInput = { eventId: a.eventId, kind: 'AVAILABILITY_CHANGED', actor: a.actor, occurredAt: today, correctsEventId: null, payload: { itemId: a.itemId, to: a.state } };
    const res = this.ledger.write(
      { workspaceId, expectedRevision: a.expectedRevision, events: [ev] },
      (st, wsRow): Decision => {
        const deny = checkHumanAction(a.actor, wsRow.kind, 'availability change');
        if (deny && !deny.ok) return { ok: false, code: deny.code, detail: deny.detail };
        const item = st.items.find((i) => i.itemId === a.itemId && i.ownership === 'CONFIRMED');
        if (!item) return { ok: false, code: 'INVALID_TRANSITION', detail: 'unknown item' };
        const cur = st.availability.find((x) => x.itemId === a.itemId)?.state ?? 'AVAILABLE';
        if (cur === a.state) return { ok: false, code: 'INVALID_TRANSITION', detail: `already ${cur}` };
        const muts: Mutation[] = [{ op: 'putAvailability', row: { itemId: a.itemId, state: a.state, since: today } }];
        const affected: string[] = [];
        if (a.state !== 'AVAILABLE') {
          for (const p of st.plans) {
            if (p.state !== 'LOCKED' || !Object.values(p.slots).includes(a.itemId)) continue;
            const t = checkTransition('LOCKED', 'NEEDS_REPLAN', 'system', wsRow.kind); // row 6
            if (!t.ok) return { ok: false, code: t.code, detail: t.detail };
            muts.push({ op: 'putPlan', plan: { ...p, state: 'NEEDS_REPLAN' } });
            affected.push(p.planId);
          }
        }
        return { ok: true, mutations: muts, result: { itemId: a.itemId, from: cur, to: a.state, needsReplan: affected, cause: a.state } };
      },
      this.clock.now().toISOString(),
    );
    if (!res.ok) return res;
    const affected = ((res.result as { needsReplan?: string[] } | null)?.needsReplan ?? []) as string[];
    const replans = affected.map((planId) => this.replan(workspaceId, planId, a.itemId));
    return { ...res, replans };
  }

  /** Row 7: re-plan only the slot whose item left; code only, zero model calls. */
  private replan(workspaceId: string, planId: string, itemId: string): Operation {
    const ws = this.ws(workspaceId);
    const state = this.ledger.readState(workspaceId, { fresh: false });
    const plan = state.plans.find((p) => p.planId === planId)!;
    const facts = factsFromState(state);
    const slot = facts.items.get(itemId)!.slot;
    const today = this.clock.today();
    const op = this.newOp(ws, 'replan', { planId, occasionDate: plan.occasionDate, context: plan.context });
    op.state = 'NEEDS_REPLAN';
    const input = buildSolverInput(plan.context, facts, today, this.rules, { current: plan.slots, only: [slot], forced: [slot] });
    op.exclusions = input.slots.flatMap((s) => s.excluded);
    const co = chooseOptions(input);
    const allFacts = buildFacts(plan.context, facts, today);
    const t = checkTransition('NEEDS_REPLAN', 'PROPOSED', 'system', ws.kind);
    if (co.options.length === 0 || !t.ok) {
      op.reasonCodes = ['NO_VALID_COMBO'];
      op.questions = [this.relaxQuestion(plan.context, co.directionOnlyMisses)];
      op.labels.push(LABELS.needsReplan);
      return this.save(op);
    }
    const o = co.options[0];
    const changes = [{ slot, from: plan.slots[slot]!, to: o.outfit[slot]! }];
    op.options = [{ ...this.optionView(0, o.outfit, [slot], o.sum, pickReasonFacts(allFacts.map((f) => f.id), changes, plan.context.direction), allFacts, 'code'), label: 'Re-plan' }];
    op.state = 'PROPOSED';
    op.labels.push(LABELS.needsReplan, changedOnly([slot], 0));
    return this.save(op);
  }

  // ---------------- step 6: wear (rows 8, 9, 12) ----------------
  wore(workspaceId: string, a: Who & { planId: string; occurredAt?: IsoDate }): WriteResponse {
    const today = this.clock.today();
    const occurredAt = a.occurredAt ?? today;
    const ev: EventInput = { eventId: a.eventId, kind: 'WEAR_CONFIRMED', actor: a.actor, occurredAt, correctsEventId: null, payload: { planId: a.planId } };
    return this.ledger.write(
      { workspaceId, expectedRevision: a.expectedRevision, events: [ev] },
      (st, wsRow): Decision => {
        const p = st.plans.find((x) => x.planId === a.planId);
        if (!p) return { ok: false, code: 'INVALID_TRANSITION', detail: 'no such plan' };
        const t = checkTransition(p.state, 'WORN', a.actor, wsRow.kind); // row 8
        if (!t.ok) return { ok: false, code: t.code, detail: t.detail };
        if (occurredAt > today) return { ok: false, code: 'INVALID_TRANSITION', detail: 'occurredAt is after today' };
        const itemIds = SLOTS.map((s) => p.slots[s]).filter((x): x is string => !!x);
        return { ok: true, mutations: [{ op: 'putPlan', plan: { ...p, state: 'WORN' } }, { op: 'insertWear', row: { eventId: a.eventId, planId: p.planId, itemIds, occurredAt } }], result: { planId: p.planId, itemIds } };
      },
      this.clock.now().toISOString(),
    );
  }

  undoWear(workspaceId: string, a: Who & { wearEventId: string }): WriteResponse {
    const today = this.clock.today();
    const ev: EventInput = { eventId: a.eventId, kind: 'WEAR_UNDONE', actor: a.actor, occurredAt: today, correctsEventId: a.wearEventId, payload: { undo: a.wearEventId } };
    return this.ledger.write(
      { workspaceId, expectedRevision: a.expectedRevision, events: [ev] },
      (st, wsRow): Decision => {
        const wear = st.wearRows.find((w) => w.eventId === a.wearEventId);
        if (!wear) return { ok: false, code: 'INVALID_TRANSITION', detail: 'no such wear (or already undone)' };
        const muts: Mutation[] = [{ op: 'deleteWear', eventId: a.wearEventId }];
        if (wear.planId) {
          const p = st.plans.find((x) => x.planId === wear.planId)!;
          const t = checkTransition(p.state, 'LOCKED', a.actor, wsRow.kind); // row 9
          if (!t.ok) return { ok: false, code: t.code, detail: t.detail };
          muts.push({ op: 'putPlan', plan: { ...p, state: 'LOCKED' } });
        } else {
          const deny = checkHumanAction(a.actor, wsRow.kind, 'past wear correction');
          if (deny && !deny.ok) return { ok: false, code: deny.code, detail: deny.detail };
        }
        return { ok: true, mutations: muts, result: { undone: a.wearEventId } };
      },
      this.clock.now().toISOString(),
    );
  }

  /** Row 12: a past wear is allowed even if the item is in LAUNDRY now; availability unchanged. */
  recordPastWear(workspaceId: string, a: Who & { itemIds: string[]; occurredAt: IsoDate }): WriteResponse {
    const today = this.clock.today();
    const ev: EventInput = { eventId: a.eventId, kind: 'WEAR_CONFIRMED', actor: a.actor, occurredAt: a.occurredAt, correctsEventId: null, payload: { planId: null, itemIds: a.itemIds } };
    return this.ledger.write(
      { workspaceId, expectedRevision: a.expectedRevision, events: [ev] },
      (st, wsRow): Decision => {
        const deny = checkHumanAction(a.actor, wsRow.kind, 'past wear (row 12)');
        if (deny && !deny.ok) return { ok: false, code: deny.code, detail: deny.detail };
        if (a.occurredAt > today) return { ok: false, code: 'INVALID_TRANSITION', detail: 'occurredAt is after today' };
        if (!a.itemIds.every((id) => st.items.some((i) => i.itemId === id && i.ownership === 'CONFIRMED'))) return { ok: false, code: 'INVALID_TRANSITION', detail: 'unknown item' };
        return { ok: true, mutations: [{ op: 'insertWear', row: { eventId: a.eventId, planId: null, itemIds: a.itemIds, occurredAt: a.occurredAt } }], result: { itemIds: a.itemIds } };
      },
      this.clock.now().toISOString(),
    );
  }

  /** Row 10: unlock. */
  unlock(workspaceId: string, a: Who & { planId: string }): WriteResponse {
    const ev: EventInput = { eventId: a.eventId, kind: 'PLAN_UNLOCKED', actor: a.actor, occurredAt: this.clock.today(), correctsEventId: null, payload: { planId: a.planId } };
    const res = this.ledger.write(
      { workspaceId, expectedRevision: a.expectedRevision, events: [ev] },
      (st, wsRow): Decision => {
        const p = st.plans.find((x) => x.planId === a.planId);
        if (!p) return { ok: false, code: 'INVALID_TRANSITION', detail: 'no such plan' };
        const t = checkTransition(p.state, 'PROPOSED', a.actor, wsRow.kind);
        if (!t.ok) return { ok: false, code: t.code, detail: t.detail };
        return { ok: true, mutations: [{ op: 'putPlan', plan: { ...p, state: 'PROPOSED' } }] };
      },
      this.clock.now().toISOString(),
    );
    if (res.ok) {
      const op = this.ledger.listOperations(workspaceId, 50).find((o) => (o as Operation).planId === a.planId && o.state === 'LOCKED') as Operation | undefined;
      if (op) {
        op.state = 'PROPOSED';
        this.save(op);
      }
    }
    return res;
  }

  // ---------------- step 7: next decision without a photo ----------------
  async startNext(workspaceId: string, a: { fromPlanId: string; sessionId?: string | null }): Promise<Operation | { ok: false; code: ReasonCode; detail: string }> {
    const ws = this.ws(workspaceId);
    if (ws.publicReadOnly) return { ok: false, code: 'SCOPE_DENIED', detail: 'read-only workspace' };
    const state = this.ledger.readState(workspaceId, { fresh: false });
    const prev = state.plans.find((p) => p.planId === a.fromPlanId);
    if (!prev) return { ok: false, code: 'INVALID_TRANSITION', detail: 'no such plan' };
    // Same intent, no photo, no offenders → direction only (§3-2 step 7, §3-5).
    const context: DecisionContext = { ...prev.context, offenders: [] };
    const op = this.newOp(ws, 'next', { sessionId: a.sessionId ?? null, context });
    this.save(op);
    return this.propose(workspaceId, { operationId: op.operationId });
  }

  // ---------------- feature 1: "오늘은 이 옷" (anchor) without a photo ----------------
  /**
   * The owner locks items they want to wear; code completes the other slots from owned, available
   * items (engine/anchor.ts). A locked item is never swapped: a conflict becomes a question.
   * The free sentence → locks/direction step is the model's job in real mode (Spark 1); here the
   * owner taps items and a direction chip.
   */
  startAnchor(workspaceId: string, a: { anchorItemIds: string[]; direction?: Direction; rainPct?: number | null; sessionId?: string | null }, existing?: Operation): Operation | { ok: false; code: ReasonCode; detail: string } {
    const ws = this.ws(workspaceId);
    if (ws.publicReadOnly) return { ok: false, code: 'SCOPE_DENIED', detail: 'read-only workspace' };
    const state = this.ledger.readState(workspaceId, { fresh: false });
    const facts = factsFromState(state);
    const lastPlan = [...state.plans].filter((p) => p.state === 'LOCKED' || p.state === 'WORN').sort((x, y) => (x.occasionDate < y.occasionDate ? 1 : x.occasionDate > y.occasionDate ? -1 : 0))[0] ?? null;
    const direction: Direction = a.direction && (DIRECTIONS as readonly string[]).includes(a.direction) ? a.direction : 'none';
    const rain = typeof a.rainPct === 'number' && Number.isFinite(a.rainPct) ? Math.max(0, Math.min(100, Math.round(a.rainPct))) : null;
    const anchors = [...new Set(a.anchorItemIds.map(String))];
    const context: DecisionContext = {
      baseline: lastPlan?.slots ?? {},
      pinned: anchors,
      direction,
      offenders: [],
      hardRules: rain !== null ? [{ kind: 'waterproof_outer_if_rain', minRainPct: 60 }] : [],
      weather: rain !== null ? { rainPct: rain } : null,
    };
    const op = existing ?? this.newOp(ws, 'anchor', { sessionId: a.sessionId ?? null });
    op.context = context;
    op.weather = context.weather;
    this.save(op);
    const today = this.clock.today();
    const r = planAnchor({ anchors, ctx: context, last: lastPlan?.slots ?? null }, facts, today, this.rules);
    if (r.kind === 'invalid') return this.hold(op, ws.kind, [r.code], null, r.detail);
    if (r.kind === 'pin_conflict') {
      const why = r.codes.includes('WEATHER_CONFLICT') ? ` is not waterproof and rain is ${rain}%` : ` is ${r.codes.join(', ').toLowerCase()}`;
      return this.hold(op, ws.kind, ['PIN_CONFLICT'], { code: 'PIN_CONFLICT', itemIds: [r.itemId], cardId: null, attr: null, choices: ['keep', 'switch'], text: `${r.itemId}${why}. Keep it anyway, or switch it?` });
    }
    if (r.kind === 'ask_formality') {
      return this.hold(op, ws.kind, ['ATTR_UNKNOWN'], { code: 'ATTR_UNKNOWN', itemIds: [r.itemId], cardId: null, attr: 'formality', choices: ['low', 'mid', 'high'], text: `How formal is ${r.itemId}?` });
    }
    if (r.kind === 'gap') {
      op.exclusions = r.excluded;
      const text = r.slots.length > 0
        ? `Nothing you own and have available fits the ${r.slots.join(' and ')} slot with ${anchors.join(', ')}. Review one in Discover, or change the request.`
        : 'No outfit with your locked items meets that direction. Relax the direction or unlock an item?';
      return this.hold(op, ws.kind, ['NO_VALID_COMBO'], { code: 'NO_VALID_COMBO', itemIds: anchors, cardId: null, attr: null, choices: r.slots.length > 0 ? ['discover', 'skip'] : ['relax', 'skip'], text });
    }
    op.exclusions = r.excluded;
    op.options = r.options.map((o, i) => ({
      index: i,
      label: o.label === 'fewest_changes' ? 'Fewer changes' : o.label === 'gentler_step' ? 'A gentler step' : 'Closer to what you said',
      outfit: o.outfit, changedSlots: o.changedSlots, sum: o.sum, reasonFactIds: [], reasonLines: o.reasonLines, source: 'code' as const,
    }));
    op.labels.push(LABELS.reasonByCode);
    return this.propose_(op, ws.kind);
  }

  /**
   * Sentence path for feature 1: Spark reads the owner's words into locks, direction and rain;
   * code checks the answer (engine/intent.ts) and then runs the same anchor planner. Anything
   * unclear becomes a question with the candidate IDs; nothing is guessed.
   */
  async startAnchorFromSentence(workspaceId: string, a: { sentence: string; sessionId?: string | null }): Promise<Operation | { ok: false; code: ReasonCode; detail: string }> {
    const ws = this.ws(workspaceId);
    if (ws.publicReadOnly) return { ok: false, code: 'SCOPE_DENIED', detail: 'read-only workspace' };
    const sentence = String(a.sentence ?? '').trim().slice(0, 300);
    if (!sentence) return { ok: false, code: 'INVALID_TRANSITION', detail: 'write what you want to wear' };
    // Public copies (visitor forks, sample closets): in real mode fixed sentences only; gate() applies the visitor caps.
    if (isPublicCopy(ws) && this.mode === 'real' && !INTENT_CHIPS.includes(sentence)) return { ok: false, code: 'META_REQUEST_REJECTED', detail: 'pick one of the example sentences' };
    const op = this.newOp(ws, 'anchor', { sessionId: a.sessionId ?? null, sentence });
    this.save(op);
    const g = this.gate(ws, op.sessionId, EST_MICRO_USD.intent);
    if (!g.ok) return this.hold(op, ws.kind, [g.code], null, g.detail);
    const state = this.ledger.readState(workspaceId, { fresh: false });
    const facts = factsFromState(state);
    const items = [...facts.items.values()].map((i) => ({ itemId: i.itemId, slot: i.slot, type: i.type, color: i.color }));
    const r = await this.ports.intent.read(sentence, items);
    this.recordCalls(op, r.calls);
    this.save(op);
    if (!r.ok) return this.hold(op, ws.kind, [r.code], null, r.detail);
    const c = checkIntent(r.value, items);
    op.labels.push(this.mode === 'mock' ? 'Sentence read by keyword rules (mock)' : 'Sentence read by Spark, checked by code');
    if (!c.ok && c.kind === 'invalid') return this.hold(op, ws.kind, ['INVALID_MODEL_OUTPUT'], null, c.detail);
    if (!c.ok) {
      const text = c.candidates.length > 1 ? `Which one did you mean by "${c.phrase}": ${c.candidates.join(' or ')}?` : 'Which piece do you want to keep? Tap it.';
      return this.hold(op, ws.kind, ['AMBIGUOUS_REFERENCE'], { code: 'AMBIGUOUS_REFERENCE', itemIds: c.candidates, cardId: null, attr: null, choices: c.candidates, text });
    }
    op.intent = { anchors: c.anchors, direction: c.direction, rain: c.rain };
    return this.startAnchor(workspaceId, { anchorItemIds: c.anchors, direction: c.direction, rainPct: c.rain ? 80 : null, sessionId: op.sessionId }, op);
  }

  // ---------------- read model ----------------
  view(workspaceId: string) {
    const ws = this.ws(workspaceId);
    const state: LedgerState = this.ledger.readState(workspaceId, { fresh: true });
    const facts: WardrobeFacts = factsFromState(state);
    const items = state.items.map((it: Item) => {
      const a = state.availability.find((x) => x.itemId === it.itemId);
      const n = facts.wearCount.get(it.itemId) ?? 0;
      return {
        ...it,
        availability: a?.state ?? 'AVAILABLE',
        since: a?.since ?? null,
        wearCount: n,
        lastWorn: facts.lastWorn.get(it.itemId) ?? null,
        wearLabel: n === 0 ? LABELS.noConfirmedWearYet : confirmedWearsSince(ws.createdOn, n),
      };
    });
    const seeded = state.items.filter((i) => i.origin === 'seed').length;
    return {
      workspace: ws,
      revision: state.revision,
      stateHash: stateHashOf(state),
      items,
      plans: state.plans,
      wearRows: state.wearRows,
      events: state.events.slice(-40).map((e) => ({ eventId: e.eventId, kind: e.kind, actor: e.actor, ledgerRevision: e.ledgerRevision, occurredAt: e.occurredAt, correctsEventId: e.correctsEventId })),
      operations: this.ledger.listOperations(workspaceId, 12),
      seededLabel: seeded > 0 ? sampleWardrobe(seeded) : null,
      today: this.clock.today(),
    };
  }

  // ---------------- Muse Wonder: a direct call the owner controls ----------------
  /**
   * One Responses-API call to Muse Wonder (or Spark, by model id) with the owner's prompt. The kill
   * switch, the caps and the call ledger apply exactly as for the photo loop; the answer is returned
   * to the caller and nothing is written to the wardrobe. Public copies never call it in real mode.
   */
  async askWonder(workspaceId: string, a: { request: WonderRequest; sessionId?: string | null }): Promise<
    { ok: true; result: WonderResult; callLines: string[]; liveChips: string[]; mode: 'mock' | 'real' } | { ok: false; code: ReasonCode; detail: string }
  > {
    const ws = this.ws(workspaceId);
    if (ws.publicReadOnly) return { ok: false, code: 'SCOPE_DENIED', detail: 'read-only workspace' };
    const publicCopy = ws.kind === 'visitor' || ws.seedRef === 'sample-closet';
    if (publicCopy && this.mode === 'real') return { ok: false, code: 'SCOPE_DENIED', detail: 'Wonder runs only on your own wardrobe' };
    const prompt = String(a.request.prompt ?? '').trim();
    if (!prompt) return { ok: false, code: 'INVALID_TRANSITION', detail: 'write a prompt' };
    const sessionId = a.sessionId ?? null;
    const g = this.gate(ws, sessionId, WONDER_EST_MICRO_USD);
    if (!g.ok) return { ok: false, code: g.code, detail: g.detail };
    const r = await this.ports.wonder.ask({ ...a.request, prompt });
    const callLines: string[] = [];
    const liveChips: string[] = [];
    for (const c of r.calls) {
      this.ledger.insertCall({ ...c, operationId: null, workspaceId, sessionId });
      callLines.push(callPanel(c));
      const chip = liveChip(c);
      if (chip) liveChips.push(chip);
    }
    if (!r.ok) return { ok: false, code: r.code, detail: r.detail };
    return { ok: true, result: r.value, callLines, liveChips, mode: this.mode };
  }
}
