// Feature 2b — price evidence and hand-off drafts. Three platforms are shown side by side and never
// merged into one "market price": an asking price is not a trade, platforms differ by region and
// currency, and unknown fees stay unknown. No platform API, scraping, listing or donation happens
// here; the owner pastes evidence they saw, or the demo shows labelled sample rows.
import type { IsoDate } from '../shared/dates.ts';
import type { Item } from '../shared/wardrobe.ts';

export const PLATFORMS = ['KREAM', 'KARROT', 'POSHMARK'] as const;
export type Platform = (typeof PLATFORMS)[number];

export type PlatformInfo = { name: string; region: string; currency: 'KRW' | 'USD'; notes: string[] };
/** Boundaries the owner should see before relying on a platform [확인 범위: Sol 11/1 탭 근거 목록]. */
export const PLATFORM_INFO: Record<Platform, PlatformInfo> = {
  KREAM: {
    name: 'KREAM', region: 'Korea', currency: 'KRW',
    notes: [
      'Separates asking (희망가) and traded (체결가) prices',
      'Inspected resale of listed models; worn apparel may not be accepted',
    ],
  },
  KARROT: {
    name: 'Karrot (당근)', region: 'Korea, by neighbourhood', currency: 'KRW',
    notes: [
      'Local listings show asking prices; final prices are agreed in person',
      'Its business OpenAPI covers ads, not used-item prices or listing',
    ],
  },
  POSHMARK: {
    name: 'Poshmark', region: 'US, Canada, Australia, India', currency: 'USD',
    notes: [
      'Shipping a Korean item to its buyers is not assumed',
      'A "Sold" banner alone does not show the final traded price',
    ],
  },
};

export const PRICE_TYPES = ['ASK', 'TRADE'] as const;
export type PriceType = (typeof PRICE_TYPES)[number];
export const MATCH_LEVELS = ['SAME_ITEM', 'SIMILAR', 'UNVERIFIED'] as const;
export type MatchLevel = (typeof MATCH_LEVELS)[number];

export type Evidence = {
  evidenceId: string;
  itemId: string;
  platform: Platform;
  priceType: PriceType;
  amount: number;
  currency: 'KRW' | 'USD';
  url: string | null;
  retrievedAt: IsoDate;
  size: string | null;
  condition: string | null;
  matchLevel: MatchLevel;
  /** 'sample' rows are demo examples and must carry the Sample chip everywhere they appear. */
  source: 'owner_entered' | 'sample';
};

export type PriceCard = {
  platform: Platform;
  info: PlatformInfo;
  status: 'HAS_EVIDENCE' | 'NO_EVIDENCE';
  entries: Evidence[];
  /** Plain text for an empty card. */
  emptyLine: string | null;
};

export function validateEvidence(e: Partial<Evidence>): string | null {
  if (!e.platform || !PLATFORMS.includes(e.platform)) return 'platform must be KREAM, KARROT or POSHMARK';
  if (!e.priceType || !PRICE_TYPES.includes(e.priceType)) return 'priceType must be ASK or TRADE';
  if (typeof e.amount !== 'number' || !Number.isFinite(e.amount) || e.amount <= 0) return 'amount must be a positive number';
  if (e.currency !== PLATFORM_INFO[e.platform].currency) return `${PLATFORM_INFO[e.platform].name} prices are in ${PLATFORM_INFO[e.platform].currency}`;
  if (!e.matchLevel || !MATCH_LEVELS.includes(e.matchLevel)) return 'matchLevel must be SAME_ITEM, SIMILAR or UNVERIFIED';
  if (!e.retrievedAt || !/^\d{4}-\d{2}-\d{2}$/.test(e.retrievedAt)) return 'retrievedAt must be YYYY-MM-DD';
  if (e.url !== null && e.url !== undefined && !/^https:\/\/[^\s]+$/.test(e.url)) return 'url must start with https://';
  return null;
}

/** One card per platform, newest evidence first. No average, no conversion between currencies. */
export function priceCards(itemId: string, evidence: readonly Evidence[]): PriceCard[] {
  return PLATFORMS.map((p) => {
    const entries = evidence
      .filter((e) => e.itemId === itemId && e.platform === p)
      .sort((a, b) => (a.retrievedAt < b.retrievedAt ? 1 : a.retrievedAt > b.retrievedAt ? -1 : a.evidenceId < b.evidenceId ? -1 : 1));
    return {
      platform: p,
      info: PLATFORM_INFO[p],
      status: entries.length > 0 ? 'HAS_EVIDENCE' : 'NO_EVIDENCE',
      entries,
      emptyLine: entries.length > 0 ? null : 'No price evidence yet. Paste one you saw, or leave this platform out.',
    };
  });
}

export type FeeLine = { label: string; kind: 'rate' | 'fixed'; value: number | null };
export type NetScenario = { price: number; currency: 'KRW' | 'USD'; deductions: { label: string; amount: number }[]; unknown: string[]; net: number | null; line: string };

/**
 * Net amount for a price the owner picks. A fee with an unknown value makes the net unknown:
 * it is listed by name and never counted as zero.
 */
export function netScenario(price: number, currency: 'KRW' | 'USD', fees: readonly FeeLine[]): NetScenario {
  const deductions: { label: string; amount: number }[] = [];
  const unknown: string[] = [];
  for (const f of fees) {
    if (f.value === null || !Number.isFinite(f.value)) unknown.push(f.label);
    else deductions.push({ label: f.label, amount: f.kind === 'rate' ? Math.round(price * f.value * 100) / 100 : f.value });
  }
  const sum = deductions.reduce((s, d) => s + d.amount, 0);
  const net = unknown.length > 0 ? null : Math.round((price - sum) * 100) / 100;
  const line = net === null
    ? `Net unknown until you check: ${unknown.join(', ')}`
    : `If it sells at ${fmt(price, currency)}, you would receive about ${fmt(net, currency)} after the fees you entered. Not a guarantee.`;
  return { price, currency, deductions, unknown, net, line };
}

export function fmt(n: number, c: 'KRW' | 'USD'): string {
  return c === 'KRW' ? `₩${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(2)}`;
}

// ---------------- hand-off drafts ----------------

export const HANDOFF_KINDS = ['SELL', 'DONATE'] as const;
export type HandoffKind = (typeof HANDOFF_KINDS)[number];
/** No SOLD or DONATED state: the app never sees the outside result. The owner may report it. */
export const HANDOFF_STATES = ['DRAFT', 'REVIEWED', 'OWNER_REPORTED_DONE'] as const;
export type HandoffState = (typeof HANDOFF_STATES)[number];

export type OwnerFacts = { brand: string | null; size: string | null; condition: string | null; purchased: string | null };

export type Handoff = {
  draftId: string;
  itemId: string;
  kind: HandoffKind;
  platform: Platform | null;
  state: HandoffState;
  title: string;
  body: string;
  /** Fields the owner still has to check before posting or handing over. */
  toCheck: string[];
  createdAt: string;
  updatedAt: string;
};

const TYPE_KO: Record<string, string> = {
  jacket: '재킷', coat: '코트', dress_shirt: '셔츠', knit: '니트', tee: '티셔츠', trousers: '슬랙스', jeans: '청바지', chinos: '치노',
  derby: '더비 슈즈', sneakers: '스니커즈', track_jacket: '트랙 재킷', blouse: '블라우스', training_top: '트레이닝 상의',
  skirt: '스커트', joggers: '조거 팬츠', shorts: '반바지', running_shoes: '러닝화', loafers: '로퍼',
};
const COLOR_KO: Record<string, string> = {
  black: '블랙', charcoal: '차콜', gray: '그레이', white: '화이트', beige: '베이지', brown: '브라운', navy: '네이비',
  blue: '블루', green: '그린', red: '레드', yellow: '옐로', pink: '핑크', unknown: '',
};

function missingFacts(f: OwnerFacts): string[] {
  const out: string[] = [];
  if (!f.brand) out.push('brand');
  if (!f.size) out.push('size');
  if (!f.condition) out.push('condition (stains, wear, repairs)');
  out.push('measurements', 'photos of the real item (front, back, label, any flaws)');
  return out;
}

/**
 * A listing text the owner edits and posts themselves. Only known facts go in; anything unknown
 * stays as a [check] placeholder. Wear records are not offered as proof of condition.
 */
export function sellDraft(item: Item, platform: Platform, f: OwnerFacts, price: { amount: number; currency: 'KRW' | 'USD' } | null): { title: string; body: string; toCheck: string[] } {
  const toCheck = missingFacts(f);
  if (!price) toCheck.push('price');
  if (platform === 'POSHMARK') {
    const name = `${f.brand ?? '[brand]'} ${item.color !== 'unknown' ? item.color : ''} ${item.type.replace('_', ' ')}`.replace(/\s+/g, ' ').trim();
    const body = [
      `${name}. Size: ${f.size ?? '[check]'}. Condition: ${f.condition ?? '[check]'}.`,
      `Measurements: [check].`,
      price ? `Price: ${fmt(price.amount, price.currency)}.` : 'Price: [check].',
      'Check that Poshmark accepts listings and shipping from your country before posting.',
    ].join('\n');
    return { title: name, body, toCheck: [...toCheck, 'whether Poshmark serves your country'] };
  }
  const name = `${f.brand ?? '[브랜드]'} ${COLOR_KO[item.color] ?? ''} ${TYPE_KO[item.type] ?? item.type}`.replace(/\s+/g, ' ').trim();
  if (platform === 'KREAM') {
    const body = [
      `품명: ${name}`, `모델 번호·품번: [확인]`, `사이즈: ${f.size ?? '[확인]'}`,
      'KREAM 판매 가능 상품인지(등록 모델·검수 기준)를 먼저 확인하세요. 사용감이 있으면 판매 대상이 아닐 수 있습니다.',
    ].join('\n');
    return { title: name, body, toCheck: [...toCheck, 'model number', 'whether KREAM accepts this item'] };
  }
  const body = [
    `${name} 팝니다.`,
    `사이즈: ${f.size ?? '[확인]'} / 상태: ${f.condition ?? '[확인]'}${f.purchased ? ` / 구매 시기: ${f.purchased}` : ''}`,
    '실측: [확인]',
    price ? `가격: ${fmt(price.amount, price.currency)}` : '가격: [확인]',
    '직거래 장소·시간은 채팅으로 정해요.',
  ].join('\n');
  return { title: name, body, toCheck };
}

/** Donation hand-off: a checklist, not a pickup booking. Acceptance, pickup and receipts are the organisation's call. */
export function donateDraft(item: Item, f: OwnerFacts): { title: string; body: string; toCheck: string[] } {
  const name = `${f.brand ? `${f.brand} ` : ''}${item.color !== 'unknown' ? `${item.color} ` : ''}${item.type.replace('_', ' ')}`;
  const body = [
    `Item: ${name}${f.size ? `, size ${f.size}` : ''}`,
    '1. Check on the organisation\'s own page which items and conditions they accept, and whether they pick up in your area.',
    '2. Wash it and check for stains, missing buttons or broken zips.',
    '3. Keep one photo for your own record.',
    '4. After you hand it over, mark it here as done yourself.',
    'Closer does not confirm acceptance, pickup, receipts or any tax benefit.',
  ].join('\n');
  return { title: `Donate: ${name}`, body, toCheck: ['accepted items and pickup area on the organisation page', 'condition'] };
}
