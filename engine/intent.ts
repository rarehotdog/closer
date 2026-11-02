// Feature 1, sentence path: "오늘 이 네이비 재킷 입을 건데 좀 편하게" → locks, direction, rain.
// The model (Spark) reads the sentence; code checks every ID against the wardrobe, allows one lock
// per slot, and turns anything unclear into a question. A keyword baseline (rulesIntent) runs in
// mock mode and is the "rules only" arm of the comparison in scripts/intent_ablation.ts.
import { DIRECTIONS, type Direction, type Item, type Slot } from '../shared/wardrobe.ts';

export type IntentRaw = { keep: string[]; direction: Direction; rain: boolean; unclear: string[] };
export type IntentChecked =
  | { ok: true; anchors: string[]; direction: Direction; rain: boolean }
  | { ok: false; kind: 'unclear'; phrase: string; candidates: string[] }
  | { ok: false; kind: 'invalid'; detail: string };

/** Wardrobe lines the model sees: ID, slot, type and colour only (no photos, no history). */
export type IntentItem = Pick<Item, 'itemId' | 'slot' | 'type' | 'color'>;

const COLOR_WORDS: Record<string, string[]> = {
  navy: ['navy', '네이비', '남색'], black: ['black', '블랙', '검정', '검은'], white: ['white', '화이트', '흰', '하얀'],
  gray: ['gray', 'grey', '그레이', '회색'], charcoal: ['charcoal', '차콜'], beige: ['beige', '베이지'], brown: ['brown', '브라운', '갈색'],
  blue: ['blue', '블루', '파란', '청'], green: ['green', '그린', '초록'], red: ['red', '레드', '빨간'], pink: ['pink', '핑크'], yellow: ['yellow', '옐로', '노란'],
};
const TYPE_WORDS: Record<string, string[]> = {
  jacket: ['jacket', 'blazer', '재킷', '자켓', '블레이저'], coat: ['coat', '코트'], track_jacket: ['track jacket', '트랙', '바람막이'],
  dress_shirt: ['shirt', '셔츠'], knit: ['knit', 'sweater', '니트', '스웨터'], tee: ['t-shirt', 'tee', '티셔츠', '반팔'], blouse: ['blouse', '블라우스'],
  training_top: ['training top', '트레이닝 상의'], trousers: ['trousers', 'slacks', '슬랙스', '정장 바지'], jeans: ['jeans', 'denim', '청바지', '데님'],
  chinos: ['chinos', '치노'], skirt: ['skirt', '스커트', '치마'], joggers: ['joggers', '조거'], shorts: ['shorts', '반바지'],
  derby: ['derby', 'dress shoes', '구두', '더비'], sneakers: ['sneakers', '스니커즈', '운동화'], running_shoes: ['running shoes', '러닝화'], loafers: ['loafers', '로퍼'],
};
const LESS = ['relaxed', 'casual', 'comfortable', 'less formal', 'dress down', '편하게', '편한', '캐주얼', '가볍게', '덜 차려'];
const MORE = ['dressy', 'formal', 'smart', 'sharp', 'dress up', '격식', '포멀', '차려', '단정', '갖춰'];
const RAIN_RE = /\brain|(^|[\s,.])비\s?(가|와|온|올|오|예보|소식)|우천|장마|우산/;

function has(text: string, words: string[]): boolean {
  return words.some((w) => text.includes(w));
}

/** Keyword baseline. Explicit IDs ("J1") always win; type words narrow by colour words when both appear. */
export function rulesIntent(sentence: string, items: readonly IntentItem[]): IntentRaw {
  const text = ` ${sentence.toLowerCase()} `;
  const keep: string[] = [];
  const unclear: string[] = [];
  for (const it of items) if (new RegExp(`\\b${it.itemId.toLowerCase()}\\b`).test(text)) keep.push(it.itemId);
  if (keep.length === 0) {
    const colors = Object.entries(COLOR_WORDS).filter(([, w]) => has(text, w)).map(([c]) => c);
    // Longer type words first so "track jacket" does not also count as "jacket".
    const types = Object.entries(TYPE_WORDS)
      .flatMap(([t, ws]) => ws.map((w) => ({ t, w })))
      .sort((a, b) => b.w.length - a.w.length);
    const seen = new Set<string>();
    let rest = text;
    for (const { t, w } of types) {
      if (!rest.includes(w) || seen.has(t)) continue;
      seen.add(t);
      rest = rest.split(w).join(' ');
      let cands = items.filter((it) => it.type === t);
      if (colors.length > 0 && cands.some((c) => colors.includes(c.color))) cands = cands.filter((c) => colors.includes(c.color));
      if (cands.length === 1) keep.push(cands[0].itemId);
      else if (cands.length > 1) unclear.push(w);
    }
  }
  const direction: Direction = has(text, LESS) ? 'less_formal' : has(text, MORE) ? 'more_formal' : 'none';
  return { keep, direction, rain: RAIN_RE.test(text), unclear };
}

/** Code check of a model or rules answer. Never trusts an ID the wardrobe does not have. */
export function checkIntent(raw: unknown, items: readonly IntentItem[]): IntentChecked {
  const r = raw as Partial<IntentRaw> | null;
  if (!r || !Array.isArray(r.keep) || typeof r.rain !== 'boolean' || !Array.isArray(r.unclear) || !(DIRECTIONS as readonly string[]).includes(String(r.direction))) {
    return { ok: false, kind: 'invalid', detail: 'intent output does not match the schema' };
  }
  const byId = new Map(items.map((i) => [i.itemId, i]));
  const keep = [...new Set(r.keep.map(String))];
  const unknown = keep.filter((id) => !byId.has(id));
  if (unknown.length > 0) return { ok: false, kind: 'invalid', detail: `not in your wardrobe: ${unknown.join(', ')}` };
  const bySlot = new Map<Slot, string[]>();
  for (const id of keep) {
    const s = byId.get(id)!.slot;
    bySlot.set(s, [...(bySlot.get(s) ?? []), id]);
  }
  for (const [slot, ids] of bySlot) if (ids.length > 1) return { ok: false, kind: 'unclear', phrase: `two ${slot} pieces`, candidates: ids };
  if (r.unclear.length > 0) {
    const phrase = String(r.unclear[0]);
    const t = Object.entries(TYPE_WORDS).find(([, ws]) => ws.some((w) => phrase.toLowerCase().includes(w)))?.[0];
    const candidates = t ? items.filter((i) => i.type === t).map((i) => i.itemId) : [];
    return { ok: false, kind: 'unclear', phrase, candidates };
  }
  if (keep.length === 0) return { ok: false, kind: 'unclear', phrase: 'which piece to keep', candidates: [] };
  return { ok: true, anchors: keep, direction: r.direction as Direction, rain: r.rain };
}

/** Fixed example sentences. In real mode the public sample closet accepts only these (no free text, no spend surprises). */
export const INTENT_CHIPS: readonly string[] = [
  '오늘은 이 네이비 재킷 입고 싶어. 나머지는 좀 편하게.',
  'Keep the navy jacket, make the rest more relaxed.',
  '흰 셔츠는 꼭 입을 거야. 비 온대.',
  'I want to wear the white sneakers, something smart for dinner.',
];
