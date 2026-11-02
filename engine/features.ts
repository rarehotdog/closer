// Read/write paths for features 2 and 3 on top of the ledger: the 60-day review, price cards,
// hand-off drafts and looks. Wear facts come from the ledger only; owner notes go to ExtrasStore.
import { randomUUID } from 'node:crypto';
import type { IsoDate } from '../shared/dates.ts';
import type { SqliteLedger } from '../store/ledger.ts';
import { ExtrasStore, HANDOFF_NEXT, type ReviewChoice } from '../store/extras.ts';
import { ALL_RULES, factsFromState, type RuleSet } from './rules.ts';
import { EXEMPT_REASONS, REVIEW_ACTIONS, clampWindow, reviewWardrobe, type Exemption, type ReviewAction, type ReviewRow } from './review.ts';
import {
  HANDOFF_KINDS, PLATFORMS, PLATFORM_INFO, donateDraft, netScenario, priceCards, sellDraft, validateEvidence,
  type Evidence, type FeeLine, type Handoff, type HandoffKind, type HandoffState, type OwnerFacts, type Platform,
} from './market.ts';
import { SAMPLE_LOOKS, lookById, matchLook, type LookCategory } from './looks.ts';
import type { DecisionContext } from '../shared/wardrobe.ts';

export type Fail = { ok: false; code: string; detail: string };
const fail = (code: string, detail: string): Fail => ({ ok: false, code, detail });

const NEUTRAL_CTX: DecisionContext = { baseline: {}, pinned: [], direction: 'none', offenders: [], hardRules: [], weather: null };

export class FeatureService {
  readonly ledger: SqliteLedger;
  readonly extras: ExtrasStore;
  readonly today: () => IsoDate;
  readonly now: () => Date;
  readonly rules: RuleSet;

  constructor(d: { ledger: SqliteLedger; extras: ExtrasStore; today: () => IsoDate; now: () => Date; rules?: RuleSet }) {
    this.ledger = d.ledger;
    this.extras = d.extras;
    this.today = d.today;
    this.now = d.now;
    this.rules = d.rules ?? ALL_RULES;
  }

  private writable(ws: string): Fail | null {
    const w = this.ledger.getWorkspace(ws);
    if (!w) return fail('SCOPE_DENIED', 'unknown workspace');
    if (w.publicReadOnly) return fail('SCOPE_DENIED', 'read-only workspace');
    return null;
  }

  // ---------------- 60-day review ----------------
  review(ws: string, windowDays?: number): { windowDays: number; rows: (ReviewRow & { lastChoice: ReviewChoice | null })[]; counts: Record<string, number>; note: string } {
    const w = this.ledger.getWorkspace(ws);
    if (!w) throw new Error('unknown workspace');
    const st = this.ledger.readState(ws, { fresh: true });
    const registeredOn = new Map<string, IsoDate>();
    for (const e of st.events) {
      if (e.kind !== 'REGISTRATION_CONFIRMED') continue;
      const id = (e.payload as { item?: { itemId?: string } } | null)?.item?.itemId;
      if (id && !registeredOn.has(id)) registeredOn.set(id, e.occurredAt);
    }
    const rows = reviewWardrobe({
      items: st.items, wearRows: st.wearRows,
      availability: new Map(st.availability.map((a) => [a.itemId, a.state])),
      registeredOn, workspaceCreatedOn: w.createdOn, exemptions: this.extras.exemptions(ws), today: this.today(), windowDays,
    });
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
    return { itemId, cards: priceCards(itemId, evidence), note: 'Each platform stands alone. Asking prices are not sales. Nothing is averaged or converted.' };
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
  net(price: number, platform: Platform, fees: unknown[]) {
    if (!PLATFORMS.includes(platform)) return fail('INVALID_TRANSITION', 'unknown platform');
    if (!(typeof price === 'number' && Number.isFinite(price) && price > 0)) return fail('INVALID_TRANSITION', 'price must be a positive number');
    if (!Array.isArray(fees) || fees.length > 10) return fail('INVALID_TRANSITION', 'up to 10 fee lines');
    const lines: FeeLine[] = [];
    for (const f of fees as Partial<FeeLine>[]) {
      const label = String(f?.label ?? '').trim().slice(0, 40);
      if (!label) return fail('INVALID_TRANSITION', 'every fee line needs a name');
      if (f?.kind !== 'rate' && f?.kind !== 'fixed') return fail('INVALID_TRANSITION', `${label}: kind must be rate or fixed`);
      const v = f.value;
      if (v !== null && v !== undefined && !(typeof v === 'number' && Number.isFinite(v) && v >= 0)) return fail('INVALID_TRANSITION', `${label}: value must be 0 or more, or blank if unknown`);
      if (f.kind === 'rate' && typeof v === 'number' && v > 1) return fail('INVALID_TRANSITION', `${label}: a rate is a share of the price (0–1, e.g. 0.1 for 10%)`);
      lines.push({ label, kind: f.kind, value: typeof v === 'number' ? v : null });
    }
    return netScenario(price, PLATFORM_INFO[platform].currency, lines);
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
}
