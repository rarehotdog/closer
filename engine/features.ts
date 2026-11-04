// Read/write paths for features 2 and 3 on top of the ledger: the 60-day review, price cards,
// hand-off drafts and looks. Wear facts come from the ledger only; owner notes go to ExtrasStore.
import { randomUUID } from 'node:crypto';
import type { IsoDate } from '../shared/dates.ts';
import type { SqliteLedger } from '../store/ledger.ts';
import { ExtrasStore, HANDOFF_NEXT, type ReviewChoice } from '../store/extras.ts';
import { ALL_RULES, factsFromState, type RuleSet } from './rules.ts';
import { EXEMPT_REASONS, REVIEW_ACTIONS, clampWindow, reviewWardrobe, type Exemption, type ReviewAction, type ReviewRow } from './review.ts';
import {
  HANDOFF_KINDS, PLATFORMS, PLATFORM_INFO, donateDraft, evidenceCoverage, netScenario, priceCards, priceSeries, sellDraft, validateEvidence,
  type Evidence, type FeeLine, type Handoff, type HandoffKind, type HandoffState, type OwnerFacts, type Platform,
} from './market.ts';
import { SAMPLE_LOOKS, collectionOf, lookById, matchLook, type Collection, type Look, type LookCategory } from './looks.ts';
import {
  DECISION_CHOICES, DEFAULT_HORIZON, HORIZON_DAYS, basisOf, evidenceSummaries, evidenceSummaryOf, isHorizon, keepSideOf, outcomeOf, recheckOf, sellSideOf, validateNamedUses,
  type DecisionChoice, type DecisionSnapshot, type EvidenceSummary, type HorizonDays, type KeepSide, type Outcome, type Recheck,
} from './decision.ts';
import type { DecisionContext } from '../shared/wardrobe.ts';
import { closetLedger as buildClosetLedger, type ClosetLedger } from './ledger.ts';

export type Fail = { ok: false; code: string; detail: string };
const fail = (code: string, detail: string): Fail => ({ ok: false, code, detail });

const NEUTRAL_CTX: DecisionContext = { baseline: {}, pinned: [], direction: 'none', offenders: [], hardRules: [], weather: null };

export type DecisionView = {
  itemId: string;
  item: { itemId: string; slot: string; type: string; color: string };
  today: IsoDate;
  horizons: number[];
  keep: KeepSide;
  evidence: EvidenceSummary[];
  /** Newest first. recheck lists the counted facts that moved since each snapshot (for its own horizon and platform). */
  history: (DecisionSnapshot & { outcome: Outcome; recheck: Recheck })[];
  note: string;
};

const CLIENT_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Fee lines as the owner typed them: a blank value is unknown, 0 counts only when typed. Returns a message when a line is malformed. */
export function parseFees(fees: unknown): FeeLine[] | string {
  if (!Array.isArray(fees)) return 'fees must be a list of cost lines';
  if (fees.length > 10) return 'up to 10 fee lines';
  const lines: FeeLine[] = [];
  for (const f of fees as Partial<FeeLine>[]) {
    const label = String(f?.label ?? '').trim().slice(0, 40);
    if (!label) return 'every fee line needs a name';
    if (f?.kind !== 'rate' && f?.kind !== 'fixed') return `${label}: kind must be rate or fixed`;
    const v = f.value;
    if (v !== null && v !== undefined && !(typeof v === 'number' && Number.isFinite(v) && v >= 0)) return `${label}: value must be 0 or more, or blank if unknown`;
    if (f.kind === 'rate' && typeof v === 'number' && v > 1) return `${label}: a rate is a share of the price (0–1, e.g. 0.1 for 10%)`;
    lines.push({ label, kind: f.kind, value: typeof v === 'number' ? v : null });
  }
  return lines;
}

export class FeatureService {
  readonly ledger: SqliteLedger;
  readonly extras: ExtrasStore;
  readonly today: () => IsoDate;
  readonly now: () => Date;
  readonly rules: RuleSet;
  /** Build identifier written into every decision snapshot (the server passes its commit). */
  readonly revision: string;

  constructor(d: { ledger: SqliteLedger; extras: ExtrasStore; today: () => IsoDate; now: () => Date; rules?: RuleSet; revision?: string }) {
    this.ledger = d.ledger;
    this.extras = d.extras;
    this.today = d.today;
    this.now = d.now;
    this.rules = d.rules ?? ALL_RULES;
    this.revision = d.revision ?? 'unknown';
  }

  private writable(ws: string): Fail | null {
    const w = this.ledger.getWorkspace(ws);
    if (!w) return fail('SCOPE_DENIED', 'unknown workspace');
    if (w.publicReadOnly) return fail('SCOPE_DENIED', 'read-only workspace');
    return null;
  }

  // ---------------- 60-day review ----------------
  /** Review rows for a window, from confirmed wear records only. */
  private reviewRows(ws: string, windowDays?: number): ReviewRow[] {
    const w = this.ledger.getWorkspace(ws);
    if (!w) throw new Error('unknown workspace');
    const st = this.ledger.readState(ws, { fresh: true });
    const registeredOn = new Map<string, IsoDate>();
    for (const e of st.events) {
      if (e.kind !== 'REGISTRATION_CONFIRMED') continue;
      const id = (e.payload as { item?: { itemId?: string } } | null)?.item?.itemId;
      if (id && !registeredOn.has(id)) registeredOn.set(id, e.occurredAt);
    }
    return reviewWardrobe({
      items: st.items, wearRows: st.wearRows,
      availability: new Map(st.availability.map((a) => [a.itemId, a.state])),
      registeredOn, workspaceCreatedOn: w.createdOn, exemptions: this.extras.exemptions(ws), today: this.today(), windowDays,
    });
  }

  review(ws: string, windowDays?: number): { windowDays: number; rows: (ReviewRow & { lastChoice: ReviewChoice | null })[]; counts: Record<string, number>; note: string } {
    const rows = this.reviewRows(ws, windowDays);
    const choices = this.extras.choices(ws);
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
    return {
      windowDays: clampWindow(windowDays),
      rows: rows.map((r) => ({ ...r, lastChoice: [...choices].reverse().find((c) => c.itemId === r.itemId) ?? null })),
      counts,
      note: 'Counts only confirmed wear records. Days with no record are unknown, not "not worn".',
    };
  }

  exempt(ws: string, a: { itemId: string; reason: string; reviewAfter: string; note?: string | null }): Exemption | Fail {
    const deny = this.writable(ws);
    if (deny) return deny;
    if (!(EXEMPT_REASONS as readonly string[]).includes(a.reason) || a.reason === 'stored') return fail('INVALID_TRANSITION', 'reason must be season, occasion, sentimental or other');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a.reviewAfter) || a.reviewAfter <= this.today()) return fail('INVALID_TRANSITION', 'reviewAfter must be a future date');
    if (!this.ownsItem(ws, a.itemId)) return fail('INVALID_TRANSITION', 'unknown item');
    return this.extras.putExemption(ws, a.itemId, { reason: a.reason as Exemption['reason'], reviewAfter: a.reviewAfter, note: a.note ?? null });
  }

  choose(ws: string, a: { itemId: string; action: string; note?: string | null }): ReviewChoice | Fail {
    const deny = this.writable(ws);
    if (deny) return deny;
    if (!(REVIEW_ACTIONS as readonly string[]).includes(a.action)) return fail('INVALID_TRANSITION', `action must be one of ${REVIEW_ACTIONS.join(', ')}`);
    if (!this.ownsItem(ws, a.itemId)) return fail('INVALID_TRANSITION', 'unknown item');
    return this.extras.addChoice(ws, { choiceId: `rc_${randomUUID().slice(0, 12)}`, itemId: a.itemId, action: a.action as ReviewAction, note: a.note ?? null, at: this.now().toISOString() });
  }

  private ownsItem(ws: string, itemId: string): boolean {
    return this.ledger.readState(ws, { fresh: false }).items.some((i) => i.itemId === itemId && i.ownership === 'CONFIRMED');
  }

  // ---------------- price evidence ----------------
  market(ws: string, itemId: string, sample: readonly Evidence[] = []) {
    const evidence = [...this.extras.evidence(ws), ...sample.filter((e) => e.itemId === itemId)];
    return { itemId, today: this.today(), cards: priceCards(itemId, evidence), series: priceSeries(itemId, evidence), note: 'Each platform stands alone. Asking prices are not sales. Nothing is averaged or converted.' };
  }

  /** How many confirmed pieces have at least one price row (owner-entered or the sample rows passed in). */
  coverage(ws: string, sample: readonly Evidence[] = []) {
    const ids = this.ledger.readState(ws, { fresh: true }).items.filter((i) => i.ownership === 'CONFIRMED').map((i) => i.itemId);
    return evidenceCoverage(ids, [...this.extras.evidence(ws), ...sample]);
  }

  /**
   * The closet ledger (engine/ledger.ts): confirmed pieces, the latest price seen per piece summed
   * per currency with owner and sample rows apart, the nets of saved positions and the 60-day wear
   * counts. Named closetLedger because `ledger` on this class is the wear-record store.
   */
  closetLedger(ws: string, sample: readonly Evidence[] = []): ClosetLedger {
    const items = this.ledger.readState(ws, { fresh: true }).items;
    return buildClosetLedger({ items, evidence: [...this.extras.evidence(ws), ...sample], decisions: this.extras.decisions(ws), reviewRows: this.review(ws, 60).rows });
  }

  addEvidence(ws: string, e: Partial<Evidence>): Evidence | Fail {
    const deny = this.writable(ws);
    if (deny) return deny;
    if (!e.itemId || !this.ownsItem(ws, e.itemId)) return fail('INVALID_TRANSITION', 'unknown item');
    const bad = validateEvidence(e);
    if (bad) return fail('INVALID_TRANSITION', bad);
    return this.extras.addEvidence(ws, {
      evidenceId: `ev_${randomUUID().slice(0, 12)}`, itemId: e.itemId, platform: e.platform!, priceType: e.priceType!, amount: e.amount!,
      currency: e.currency!, url: e.url ?? null, retrievedAt: e.retrievedAt!, size: e.size ?? null, condition: e.condition ?? null,
      matchLevel: e.matchLevel!, source: 'owner_entered',
    });
  }

  /**
   * Net amount for a price the owner picks. Fee lines come from the owner: a blank value means
   * "not checked yet" and keeps the net unknown; 0 counts only when the owner typed 0.
   */
  net(price: number, platform: Platform, fees: unknown) {
    if (!PLATFORMS.includes(platform)) return fail('INVALID_TRANSITION', 'unknown platform');
    if (!(typeof price === 'number' && Number.isFinite(price) && price > 0)) return fail('INVALID_TRANSITION', 'price must be a positive number');
    const lines = parseFees(fees);
    if (typeof lines === 'string') return fail('INVALID_TRANSITION', lines);
    return netScenario(price, PLATFORM_INFO[platform].currency, lines);
  }

  // ---------------- keep or let go ----------------
  /**
   * The two sides of one piece's question, read from counted records and the owner's own price
   * evidence (sample rows stay labelled). Nothing here is estimated; the wear outlook stays null.
   */
  decisionView(ws: string, a: { itemId: string; horizonDays?: number }, sample: readonly Evidence[] = []): DecisionView | Fail {
    if (!this.ledger.getWorkspace(ws)) return fail('SCOPE_DENIED', 'unknown workspace');
    const st = this.ledger.readState(ws, { fresh: true });
    const item = st.items.find((i) => i.itemId === a.itemId && i.ownership === 'CONFIRMED');
    if (!item) return fail('INVALID_TRANSITION', 'unknown item');
    const horizonDays = a.horizonDays === undefined ? DEFAULT_HORIZON : a.horizonDays;
    if (!isHorizon(horizonDays)) return fail('INVALID_TRANSITION', `horizonDays must be one of ${HORIZON_DAYS.join(', ')}`);
    const rowsFor = new Map<HorizonDays, ReviewRow[]>([[horizonDays, this.reviewRows(ws, horizonDays)]]);
    const row = rowsFor.get(horizonDays)!.find((r) => r.itemId === item.itemId);
    if (!row) return fail('INVALID_TRANSITION', 'unknown item');
    const today = this.today();
    const history = this.extras.decisions(ws, item.itemId);
    const last = history[history.length - 1] ?? null;
    const evidence = [...this.extras.evidence(ws), ...sample.filter((e) => e.itemId === item.itemId)];
    // The keep side as it stands today for a snapshot's own horizon, so a different horizon on screen is not reported as moved facts.
    const keepNow = (d: DecisionSnapshot): KeepSide | null => {
      if (!rowsFor.has(d.keep.horizonDays)) rowsFor.set(d.keep.horizonDays, this.reviewRows(ws, d.keep.horizonDays));
      const r = rowsFor.get(d.keep.horizonDays)!.find((x) => x.itemId === item.itemId);
      return r ? keepSideOf(item, r, d.keep.horizonDays, d.keep.namedUses, today) : null;
    };
    const recheck = (d: DecisionSnapshot): Recheck => {
      const now = keepNow(d);
      return now ? recheckOf(d, now, evidenceSummaryOf(item.itemId, d.sell.platform, evidence)) : { needed: false, changed: [] };
    };
    return {
      itemId: item.itemId,
      item: { itemId: item.itemId, slot: item.slot, type: item.type, color: item.color },
      today,
      horizons: [...HORIZON_DAYS],
      keep: keepSideOf(item, row, horizonDays, last?.keep.namedUses ?? [], today),
      evidence: evidenceSummaries(item.itemId, evidence),
      history: history.map((d) => ({ ...d, outcome: outcomeOf(d, st.wearRows, today), recheck: recheck(d) })).reverse(),
      note: 'Both sides show counts and the prices you entered. No probability is shown because there is no counted basis for one. Taking a position saves a snapshot of this screen and changes nothing outside Closer.',
    };
  }

  /**
   * Save a position as a snapshot. The net is recomputed here from the cost lines; a net sent by a
   * client is ignored. With a clientKey the save is idempotent: the same key on the same facts
   * returns the row already saved (duplicate: true) instead of a second row; the same key on
   * different facts is refused, because that position would rest on a screen the owner has not seen.
   */
  decide(ws: string, a: { itemId: string; choice: string; horizonDays?: number; platform: string; askPrice?: unknown; fees?: unknown; namedUses?: unknown; note?: string | null; clientKey?: string | null }, sample: readonly Evidence[] = []): { decision: DecisionSnapshot; outcome: Outcome; duplicate?: true } | Fail {
    const deny = this.writable(ws);
    if (deny) return deny;
    const clientKey = a.clientKey === undefined || a.clientKey === null ? null : String(a.clientKey);
    if (clientKey !== null && !CLIENT_KEY_RE.test(clientKey)) return fail('INVALID_TRANSITION', 'clientKey must be 8 to 64 letters, digits, _ or -');
    if (!(DECISION_CHOICES as readonly string[]).includes(a.choice)) return fail('INVALID_TRANSITION', `choice must be one of ${DECISION_CHOICES.join(', ')}`);
    if (!(PLATFORMS as readonly string[]).includes(a.platform)) return fail('INVALID_TRANSITION', 'unknown platform');
    const horizonDays = a.horizonDays === undefined ? DEFAULT_HORIZON : a.horizonDays;
    if (!isHorizon(horizonDays)) return fail('INVALID_TRANSITION', `horizonDays must be one of ${HORIZON_DAYS.join(', ')}`);
    // A price sent as text or any other shape is refused rather than dropped, so a saved position never rests on a price the owner did not see.
    const askPrice = a.askPrice === undefined || a.askPrice === null ? null : typeof a.askPrice === 'number' && Number.isFinite(a.askPrice) && a.askPrice > 0 ? a.askPrice : undefined;
    if (askPrice === undefined) return fail('INVALID_TRANSITION', 'askPrice must be a positive number or blank');
    const fees = parseFees(a.fees ?? []);
    if (typeof fees === 'string') return fail('INVALID_TRANSITION', fees);
    const today = this.today();
    const namedUses = validateNamedUses(a.namedUses, today);
    if (typeof namedUses === 'string') return fail('INVALID_TRANSITION', namedUses);
    const note = a.note === undefined || a.note === null ? null : String(a.note).trim().slice(0, 200) || null;
    const st = this.ledger.readState(ws, { fresh: true });
    const item = st.items.find((i) => i.itemId === a.itemId && i.ownership === 'CONFIRMED');
    if (!item) return fail('INVALID_TRANSITION', 'unknown item');
    const row = this.reviewRows(ws, horizonDays).find((r) => r.itemId === item.itemId);
    if (!row) return fail('INVALID_TRANSITION', 'unknown item');
    const evidence = [...this.extras.evidence(ws), ...sample.filter((e) => e.itemId === item.itemId)];
    const keep = keepSideOf(item, row, horizonDays, namedUses, today);
    const sell = sellSideOf(item.itemId, a.platform as Platform, askPrice, fees, evidence);
    const basis = basisOf(keep, sell);
    const prior = clientKey === null ? null : this.extras.decisionByKey(ws, clientKey);
    if (prior) {
      if (prior.basis !== basis) return fail('INVALID_TRANSITION', 'this position was already saved on different facts; open it again to take a new position');
      return { decision: prior, outcome: outcomeOf(prior, st.wearRows, today), duplicate: true };
    }
    const snapshot: DecisionSnapshot = {
      schema: 'closer.decision.1',
      decisionId: `d_${randomUUID().slice(0, 12)}`,
      itemId: item.itemId,
      choice: a.choice as DecisionChoice,
      at: this.now().toISOString(),
      today,
      keep,
      sell,
      basis,
      note,
      sourceRevision: this.revision,
    };
    const saved = this.extras.addDecision(ws, snapshot, clientKey);
    return { decision: saved, outcome: outcomeOf(saved, st.wearRows, today) };
  }

  decisions(ws: string, itemId?: string): (DecisionSnapshot & { outcome: Outcome })[] {
    const st = this.ledger.readState(ws, { fresh: true });
    const today = this.today();
    return this.extras.decisions(ws, itemId).map((d) => ({ ...d, outcome: outcomeOf(d, st.wearRows, today) }));
  }

  // ---------------- hand-off drafts ----------------
  draft(ws: string, a: { itemId: string; kind: string; platform?: string | null; facts?: Partial<OwnerFacts>; price?: number | null }): Handoff | Fail {
    const deny = this.writable(ws);
    if (deny) return deny;
    if (!(HANDOFF_KINDS as readonly string[]).includes(a.kind)) return fail('INVALID_TRANSITION', 'kind must be SELL or DONATE');
    const item = this.ledger.readState(ws, { fresh: false }).items.find((i) => i.itemId === a.itemId && i.ownership === 'CONFIRMED');
    if (!item) return fail('INVALID_TRANSITION', 'unknown item');
    const facts: OwnerFacts = { brand: a.facts?.brand ?? null, size: a.facts?.size ?? null, condition: a.facts?.condition ?? null, purchased: a.facts?.purchased ?? null };
    let platform: Platform | null = null;
    let text: { title: string; body: string; toCheck: string[] };
    if (a.kind === 'SELL') {
      if (!a.platform || !(PLATFORMS as readonly string[]).includes(a.platform)) return fail('INVALID_TRANSITION', 'pick a platform for a sale draft');
      platform = a.platform as Platform;
      const price = typeof a.price === 'number' && a.price > 0 ? { amount: a.price, currency: PLATFORM_INFO[platform].currency } : null;
      text = sellDraft(item, platform, facts, price);
    } else {
      text = donateDraft(item, facts);
    }
    const at = this.now().toISOString();
    return this.extras.putHandoff(ws, { draftId: `hd_${randomUUID().slice(0, 12)}`, itemId: item.itemId, kind: a.kind as HandoffKind, platform, state: 'DRAFT', ...text, createdAt: at, updatedAt: at });
  }

  /** DRAFT → REVIEWED (owner read and edited it) → OWNER_REPORTED_DONE (owner says they posted or handed it over). */
  moveDraft(ws: string, a: { draftId: string; to: string; body?: string }): Handoff | Fail {
    const deny = this.writable(ws);
    if (deny) return deny;
    const h = this.extras.handoff(ws, a.draftId);
    if (!h) return fail('INVALID_TRANSITION', 'no such draft');
    const to = a.to as HandoffState;
    if (!HANDOFF_NEXT[h.state].includes(to)) return fail('INVALID_TRANSITION', `cannot go from ${h.state} to ${a.to}`);
    if (to === 'REVIEWED' && /\[(check|확인|brand|브랜드)\]/.test(a.body ?? h.body)) return fail('NEEDS_CHECK', 'fill every [check] placeholder before marking it reviewed');
    return this.extras.putHandoff(ws, { ...h, state: to, body: a.body ?? h.body, updatedAt: this.now().toISOString() });
  }

  drafts(ws: string): Handoff[] {
    return this.extras.handoffs(ws);
  }

  // ---------------- looks ----------------
  looks(category?: string) {
    return SAMPLE_LOOKS.filter((l) => !category || l.category === (category as LookCategory));
  }

  matchLook(ws: string, lookId: string) {
    const look = lookById(lookId);
    if (!look) return fail('INVALID_TRANSITION', 'no such look');
    const facts = factsFromState(this.ledger.readState(ws, { fresh: true }));
    return matchLook(look, facts, NEUTRAL_CTX, this.today(), this.rules);
  }

  // ---------------- style targets ----------------
  /** Looks the owner wants to be able to wear. Stored outside stateHash; read back on every write. */
  setTarget(ws: string, a: { lookId: string; on: boolean }): { targets: string[] } | Fail {
    const deny = this.writable(ws);
    if (deny) return deny;
    if (!lookById(a.lookId)) return fail('INVALID_TRANSITION', 'no such look');
    return { targets: this.extras.setTarget(ws, a.lookId, a.on === true, this.now().toISOString()) };
  }

  /** The target looks measured against the closet: counted pieces, an item box, no estimates. */
  collection(ws: string): Collection {
    const targets = this.extras.targets(ws).map(lookById).filter((l): l is Look => l !== null);
    const facts = factsFromState(this.ledger.readState(ws, { fresh: true }));
    return collectionOf(targets, facts, NEUTRAL_CTX, this.today(), this.rules);
  }
}
