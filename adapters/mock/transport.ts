// 미검증 — 문서 예시 기반, 실호출 0
// Mock transport (default mode). Answers with Responses-API-shaped JSON like the doc examples so the
// same request builders and parsers run as in real mode. No network. Scriptable per test.
import { chooseOptions } from '../../engine/solver.ts';
import { pickReasonFacts } from '../../engine/facts.ts';
import { encodeMockRle, type PixelBox } from '../../engine/coords.ts';
import { garmentShape, spark1Truth, type PhotoLibrary } from '../../fixtures/photos.ts';
import type { HttpResult } from '../../engine/retry.ts';
import type { Transport, TransportRequest } from '../transport.ts';
import { SAM_MODEL } from '../responses.ts';
import type { Spark2Facts } from '../types.ts';
import { rulesIntent, type IntentItem } from '../../engine/intent.ts';

export type MockReply = { status: number; headers?: Record<string, string>; json?: unknown };
type Reply = MockReply | null | Promise<MockReply | null>;

export type MockScript = {
  /** Patch the default Spark 1 output (e.g. AT-36 color mismatch). */
  spark1Patch?: (out: Record<string, unknown>, ctx: { photoId: string; sentence: string }) => Record<string, unknown>;
  /** Scripted reply for the n-th call (0-based) of each model; null → default behavior. */
  spark1?: (n: number) => Reply;
  sam?: (n: number) => Reply;
  spark2?: (n: number, facts: Spark2Facts & { correction: unknown }) => Reply;
  /** Scripted reply for the n-th intent call; null → keyword baseline answer. */
  intent?: (n: number, input: { sentence: string; items: IntentItem[] }) => Reply;
};

export type MockLogEntry = { kind: 'spark1' | 'sam' | 'spark2' | 'intent'; n: number; status: number };
export type MockTransport = Transport & { log: MockLogEntry[] };

let seq = 0;
const nextId = (kind: string) => `resp_mock_${kind}_${(++seq).toString(36).padStart(4, '0')}`;

export function textResponse(model: string, text: string, kind: string): MockReply {
  return {
    status: 200,
    headers: {},
    json: { id: nextId(kind), object: 'response', model, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: null },
  };
}

export function toolResponse(model: string, name: string, args: unknown, kind = 'spark2'): MockReply {
  return {
    status: 200,
    headers: {},
    json: {
      id: nextId(kind),
      object: 'response',
      model,
      status: 'completed',
      output: [{ type: 'function_call', call_id: `call_${(++seq).toString(36)}`, name, arguments: JSON.stringify(args), status: 'completed' }],
      usage: null,
    },
  };
}

export function errorResponse(status: number, retryAfterSec?: number): MockReply {
  return {
    status,
    headers: retryAfterSec !== undefined ? { 'retry-after': String(retryAfterSec) } : {},
    json: { error: { message: `mock HTTP ${status}`, type: status >= 500 ? 'server_error' : 'invalid_request_error', param: null, code: status === 404 ? 'model_not_found' : 'mock' } },
  };
}

function userContent(body: Record<string, unknown>): { text: string; imageUrl: string | null } {
  const input = body.input as { role?: string; content?: { type: string; text?: string; image_url?: string }[] }[];
  const user = input.find((m) => m.role === 'user');
  const text = user?.content?.find((c) => c.type === 'input_text')?.text ?? '';
  const imageUrl = user?.content?.find((c) => c.type === 'input_image')?.image_url ?? null;
  return { text, imageUrl };
}

const BOX_RE = /(\d+)<\|box;x1=(\d+);y1=(\d+);x2=(\d+);y2=(\d+);w=(\d+);h=(\d+)\|>/g;

function samDefault(lib: PhotoLibrary, prompt: string, imageUrl: string | null): MockReply {
  const photo = imageUrl ? lib.byUrl(imageUrl) : null;
  if (!photo) return errorResponse(400);
  const records: { id: number; area: number; token: string }[] = [];
  for (const m of prompt.matchAll(BOX_RE)) {
    const id = Number(m[1]);
    const box: PixelBox = { x1: Number(m[2]), y1: Number(m[3]), x2: Number(m[4]), y2: Number(m[5]) };
    const w = Number(m[6]), h = Number(m[7]);
    if (w !== photo.w || h !== photo.h) return errorResponse(400);
    // The garment that fills most of this box.
    let best: { inside: (x: number, y: number) => boolean } | null = null;
    let bestCount = -1;
    for (const g of photo.garments) {
      const s = garmentShape(g.box);
      const cx = Math.floor((box.x1 + box.x2) / 2), cy = Math.floor((box.y1 + box.y2) / 2);
      const count = s.inside(cx, cy) ? 1 : 0;
      if (count > bestCount) {
        bestCount = count;
        best = s;
      }
    }
    // Tight bounding box of the garment pixels inside the prompted box.
    let tx1 = Infinity, ty1 = Infinity, tx2 = -1, ty2 = -1;
    for (let y = box.y1; y <= box.y2; y++) {
      for (let x = box.x1; x <= box.x2; x++) {
        if (best!.inside(x, y)) {
          if (x < tx1) tx1 = x;
          if (y < ty1) ty1 = y;
          if (x > tx2) tx2 = x;
          if (y > ty2) ty2 = y;
        }
      }
    }
    if (tx2 < 0) continue; // nothing found: SAM returns no record for this id
    const mw = tx2 - tx1 + 1, mh = ty2 - ty1 + 1;
    const bits = new Uint8Array(mw * mh);
    for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) bits[y * mw + x] = best!.inside(tx1 + x, ty1 + y) ? 1 : 0;
    records.push({
      id,
      area: mw * mh,
      token: `${id}<|box;x1=${tx1};y1=${ty1};x2=${tx2};y2=${ty2};w=${w};h=${h}|><|mask;x=0;y=0;data=${mh},${mw},R${encodeMockRle(bits)}|>`,
    });
  }
  // Mock "arrival order": smallest mask first (deterministic, not id order).
  records.sort((a, b) => a.area - b.area || a.id - b.id);
  return textResponse(SAM_MODEL, `<0f>${records.map((r) => r.token).join(',')}`, 'sam');
}

function spark2Default(facts: Spark2Facts): MockReply {
  const r = chooseOptions(facts.solver);
  if (r.options.length === 0) return toolResponse('muse-spark-1.3', 'ask_owner', { questionCode: 'NO_VALID_COMBO', itemIds: [] });
  return toolResponse('muse-spark-1.3', 'propose_edit', {
    options: r.options.map((o) => ({
      changes: o.changes.map((c) => ({ slot: c.slot, itemId: c.to })),
      reasonFactIds: pickReasonFacts(facts.factIds, o.changes, facts.solver.direction),
      visual_match: [],
    })),
  });
}

export function createMockTransport(lib: PhotoLibrary, script: MockScript = {}): MockTransport {
  const counts = { spark1: 0, sam: 0, spark2: 0, intent: 0 };
  const log: MockLogEntry[] = [];
  const t = async (req: TransportRequest): Promise<HttpResult> => {
    const body = req.body;
    const { text, imageUrl } = userContent(body);
    let kind: 'spark1' | 'sam' | 'spark2' | 'intent';
    if (body.model === SAM_MODEL) kind = 'sam';
    else if ((body.text as { format?: { name?: string } } | undefined)?.format?.name === 'closer_intent') kind = 'intent';
    else if (Array.isArray(body.tools)) kind = 'spark2';
    else kind = 'spark1';
    const n = counts[kind]++;
    let reply: MockReply | null = null;
    if (kind === 'intent') {
      const input = JSON.parse(text) as { sentence: string; items: IntentItem[] };
      reply = (await script.intent?.(n, input)) ?? textResponse('muse-spark-1.3', JSON.stringify(rulesIntent(input.sentence, input.items)), 'intent');
    } else if (kind === 'spark1') {
      reply = (await script.spark1?.(n)) ?? null;
      if (!reply) {
        const photo = imageUrl ? lib.byUrl(imageUrl) : null;
        let out = photo ? (spark1Truth(photo.photoId, text) as Record<string, unknown> | null) : null;
        if (!out) reply = textResponse('muse-spark-1.3', JSON.stringify({ garments: [], pin: [], direction: 'none', offenders: [], reasonCandidates: [] }), 'spark1');
        else {
          if (script.spark1Patch) out = script.spark1Patch(out, { photoId: photo!.photoId, sentence: text });
          reply = textResponse('muse-spark-1.3', JSON.stringify(out), 'spark1');
        }
      }
    } else if (kind === 'sam') {
      reply = (await script.sam?.(n)) ?? samDefault(lib, text, imageUrl);
    } else {
      const facts = JSON.parse(text) as Spark2Facts & { correction: unknown };
      reply = (await script.spark2?.(n, facts)) ?? spark2Default(facts);
    }
    log.push({ kind, n, status: reply.status });
    return { status: reply.status, headers: reply.headers ?? {}, json: reply.json ?? null };
  };
  return Object.assign(t, { log });
}
