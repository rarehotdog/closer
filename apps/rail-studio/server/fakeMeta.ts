// TEST ONLY: a stand-in for the Meta Model API, so the scan flow can be exercised without a key.
// It answers every outfit photo with the same two garments (a jacket over trousers), every closet
// photo with the same six pieces on a rail, and elliptical masks
// inside the prompted boxes. The server runs it only with CLOSER_SCAN_FAKE=1 and labels every
// result "Test fake · no Meta call"; it is never used when a key is set.
import type { Transport } from './closer/adapters/transport.ts';
import { encodeMockRle } from './closer/engine/coords.ts';
import { SAM_MODEL, SPARK_MODEL } from './closer/adapters/responses.ts';

export const FAKE_SPARK_ANSWER = {
  garments: [
    { box: [240, 110, 760, 560], type: 'jacket', color_family: 'navy', formality: 'high' },
    { box: [300, 520, 700, 985], type: 'trousers', color_family: 'gray', formality: 'mid' },
  ],
  pin: [0],
  direction: 'less_formal',
  offenders: [{ index: 1, why: 'too_formal' }],
  reasonCandidates: ['too_formal'],
};

/** Closet mode: six pieces on a rail, two jackets and two tops among them (no one-per-slot rule). */
export const FAKE_CLOSET_ANSWER = {
  garments: [
    { box: [20, 80, 180, 700], type: 'coat', color_family: 'beige', formality: 'high' },
    { box: [190, 80, 340, 560], type: 'jacket', color_family: 'navy', formality: 'high' },
    { box: [350, 80, 500, 560], type: 'jacket', color_family: 'black', formality: 'mid' },
    { box: [510, 80, 660, 480], type: 'knit', color_family: 'gray', formality: 'mid' },
    { box: [670, 80, 820, 460], type: 'tee', color_family: 'white', formality: 'low' },
    { box: [830, 80, 980, 760], type: 'trousers', color_family: 'charcoal', formality: 'mid' },
  ],
  more_not_listed: false,
};

const PROMPT_BOX = /(\d+)<\|box;x1=(\d+);y1=(\d+);x2=(\d+);y2=(\d+);w=(\d+);h=(\d+)\|>/g;

const reply = (model: string, text: string) => ({
  status: 200,
  headers: {},
  json: { id: `fake_${model}`, object: 'response', model, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: null },
});

/** Ellipse inscribed in the box, 4% inset: looks like a garment silhouette, stays inside the box. */
function ellipseRecord(id: number, x1: number, y1: number, x2: number, y2: number, w: number, h: number): string {
  const mw = x2 - x1 + 1, mh = y2 - y1 + 1;
  const bits = new Uint8Array(mw * mh);
  const cx = (mw - 1) / 2, cy = (mh - 1) / 2, rx = mw * 0.46, ry = mh * 0.46;
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) bits[y * mw + x] = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1 ? 1 : 0;
  return `${id}<|box;x1=${x1};y1=${y1};x2=${x2};y2=${y2};w=${w};h=${h}|><|mask;x=0;y=0;data=${mh},${mw},R${encodeMockRle(bits)}|>`;
}

export function createFakeMetaTransport(opts: { samStatus?: number } = {}): Transport {
  return async ({ body }) => {
    const model = String((body as { model?: unknown }).model ?? '');
    if (model === SPARK_MODEL) {
      const schema = (body as { text?: { format?: { name?: string } } }).text?.format?.name;
      return reply(SPARK_MODEL, JSON.stringify(schema === 'closer_closet' ? FAKE_CLOSET_ANSWER : FAKE_SPARK_ANSWER));
    }
    if (model === SAM_MODEL) {
      if (opts.samStatus && opts.samStatus !== 200) return { status: opts.samStatus, headers: {}, json: { error: { message: 'fake SAM failure' } } };
      const input = JSON.stringify((body as { input?: unknown }).input ?? '');
      const records: string[] = [];
      for (const m of input.matchAll(PROMPT_BOX)) {
        const [id, x1, y1, x2, y2, w, h] = m.slice(1).map(Number);
        records.push(ellipseRecord(id, x1, y1, x2, y2, w, h));
      }
      return reply(SAM_MODEL, `<0f>${records.join(',')}`);
    }
    return { status: 400, headers: {}, json: { error: { message: `fake transport does not know model ${model}` } } };
  };
}
