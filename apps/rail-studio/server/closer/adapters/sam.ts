// 실호출 기록: docs/live/live_check.json (2026-11-05, 1회) — 그 기록 밖의 응답 형태는 문서 예시 기반
// SAM 3.1: same image + box prompts (object IDs 1–n chosen by code) in one request → one box and
// one mask per ID. Non-streaming (streaming is optional per the SAM docs). store:false (§3-4).
// Live responses are read by the official parser (@meta-sam/parser): fields by name in any order,
// masks decoded by the library. The mock transport keeps its positional records and 'R' masks.
import { decodeMaskToRaster, formats, parseResponsesStream, recordsOfKind, type ResponsesEvent, type SegmentationBoxRecord, type SegmentationDiagnostic, type SegmentationMaskRecord } from '@meta-sam/parser';
import { decodeMockRle, parseSegmentation, type MaskRaster, type PixelBox, type SamMaskWire } from '../engine/coords.ts';
import type { SamRecord } from '../engine/validate.ts';
import { callResponses, EST_MICRO_USD, httpFailure, outputText, SAM_IMAGE_MICRO_USD, SAM_MODEL, type CallDeps } from './responses.ts';
import type { SamPort, SamRequest } from './types.ts';

export type SamBodyOptions = {
  /**
   * CLOSER_SAM_METADATA=1 also sends metadata.mask_encoding one_bit. Off by default: box prompts
   * return one_bit either way, and the key is not in the protocol's metadata list, so an unknown
   * key must not be the reason the first live call fails.
   */
  metadata?: boolean;
};

export function buildSamBody(req: SamRequest, opts: SamBodyOptions = {}): Record<string, unknown> {
  return {
    model: SAM_MODEL,
    store: false,
    ...(opts.metadata ? { metadata: { mask_encoding: 'one_bit' } } : {}),
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: req.prompt },
          { type: 'input_image', image_url: req.imageUrl },
        ],
      },
    ],
  };
}

/**
 * Decoder for a scripted mock reply that carries a documented encoding ('~' lossless, '!' one_bit);
 * adapters/samDecoder.ts wraps the official one. The mock transport's own 'R' run-length encoding
 * is decoded here. Live responses never use this: the official parser decodes their masks.
 */
export type MaskDecoder = (wire: SamMaskWire) => Uint8Array;

/** Mock transport records: positional grammar (engine/coords.ts), 'R' masks, decodeMask for the rest. */
export function parseMockSegmentation(text: string, decodeMask?: MaskDecoder): SamRecord[] {
  const records: SamRecord[] = [];
  for (const w of parseSegmentation(text)) {
    let raster: MaskRaster | null = null;
    if (w.mask) {
      const size = w.mask.h * w.mask.w;
      let bits: Uint8Array;
      if (w.mask.enc === 'R') bits = decodeMockRle(w.mask.payload, size);
      else if (decodeMask) bits = decodeMask(w.mask);
      else throw new Error(`no decoder for mask encoding '${w.mask.enc}'`);
      raster = { x: w.box.x1, y: w.box.y1, w: w.mask.w, h: w.mask.h, bits };
    }
    records.push({ id: w.id, box: w.box, frameW: w.frameW, frameH: w.frameH, raster });
  }
  return records;
}

export type LiveSegmentation = { records: SamRecord[]; diagnostics: string[] };

/** The completed output text as one finalized lane, the way the parser's README feeds it. */
async function* completedLane(text: string): AsyncGenerator<ResponsesEvent> {
  yield { type: 'response.output_text.done', item_id: 'message-0', output_index: 0, content_index: 0, text };
  yield { type: 'response.completed' };
}

type BoxToken = { id: string; x1: number; y1: number; x2: number; y2: number; w: number; h: number };

/**
 * Frame size per box token, read by name (any field order). The official parser checks w and h
 * but does not expose them on its records; validateSam needs them (sent size = reported size).
 */
function boxTokens(text: string): BoxToken[] {
  const out: BoxToken[] = [];
  for (const m of text.matchAll(/(\d+)\s*<\|box;([^|]*)\|>/g)) {
    const f = new Map<string, string>();
    for (const part of m[2].split(';')) {
      const i = part.indexOf('=');
      if (i > 0) f.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
    const n = (k: string) => Number(f.get(k));
    out.push({ id: m[1], x1: n('x1'), y1: n('y1'), x2: n('x2'), y2: n('y2'), w: n('w'), h: n('h') });
  }
  return out;
}

function summarise(diagnostics: readonly SegmentationDiagnostic[]): string[] {
  const counts = new Map<string, number>();
  for (const d of diagnostics) {
    const key = `${d.code} (${d.severity})`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts.size ? [`SAM parser: ${[...counts].map(([k, n]) => `${k} ×${n}`).join(', ')}`] : [];
}

/**
 * Live response text → SamRecords through the official parser. Boxes come back half-open
 * (right = x2 + 1, bottom = y2 + 1) and are turned back into the inclusive wire form used here.
 * Diagnostics (an ignored field, a malformed record, …) are summarised for the call line; a record
 * the parser dropped shows up as a missing id in validateSam.
 */
export async function parseLiveSegmentation(text: string): Promise<LiveSegmentation> {
  const result = await parseResponsesStream(completedLane(text), formats.segmentation.image()).finalResult;
  const diagnostics = summarise(result.diagnostics);
  const entries: { box: SegmentationBoxRecord; mask: SegmentationMaskRecord | null }[] = [];
  for (const rec of result.records) {
    if (rec.kind === 'box') entries.push({ box: rec, mask: null });
    else if (rec.kind === 'mask') {
      const e = [...entries].reverse().find((x) => x.box.objectId === rec.objectId);
      if (e) e.mask = rec;
    }
  }
  // One record per object id: a repeated id keeps its last box and mask, as the parser's revisions do.
  const last = new Map<string, { box: SegmentationBoxRecord; mask: SegmentationMaskRecord | null }>();
  for (const e of entries) last.set(e.box.objectId, e);
  const tokens = boxTokens(text);
  const records: SamRecord[] = [];
  for (const { box: b, mask: m } of last.values()) {
    const id = Number(b.objectId);
    if (!Number.isInteger(id) || id < 0) throw new Error(`SAM object id '${b.objectId}' is not a non-negative integer`);
    const box: PixelBox = { x1: b.left, y1: b.top, x2: b.right - 1, y2: b.bottom - 1 };
    const tok = tokens.find((t) => Number(t.id) === id && t.x1 === box.x1 && t.y1 === box.y1 && t.x2 === box.x2 && t.y2 === box.y2);
    if (!tok) throw new Error(`SAM record ${id}: frame size could not be read`);
    let raster: MaskRaster | null = null;
    if (m) {
      const bits = decodeMaskToRaster(m.mask); // throws InvalidSegmentationMaskError on a bad payload
      raster = { x: box.x1, y: box.y1, w: m.mask.width, h: m.mask.height, bits };
    }
    records.push({ id, box, frameW: tok.w, frameH: tok.h, raster });
  }
  return { records, diagnostics };
}

export type SamPortDeps = CallDeps & { decodeMask?: MaskDecoder } & SamBodyOptions;

export function createSamPort(deps: SamPortDeps): SamPort {
  return {
    async segment(req) {
      const { outcome, calls } = await callResponses(deps, buildSamBody(req, { metadata: deps.metadata }), {
        model: SAM_MODEL,
        estMicroUsd: EST_MICRO_USD.sam,
        price: () => SAM_IMAGE_MICRO_USD,
      });
      const f = outcome.final;
      if (!f || f.status < 200 || f.status >= 300) return httpFailure('SAM', f, calls);
      const text = outputText(f.json);
      if (text === null) return { ok: false, http: f.status, code: 'INVALID_MODEL_OUTPUT', detail: 'no output_text in the SAM response', calls };
      try {
        if (deps.source === 'live') {
          const live = await parseLiveSegmentation(text);
          const notes = [...live.diagnostics];
          const status = (f.json as { status?: unknown } | null)?.status;
          if (typeof status === 'string' && status !== 'completed') notes.push(`SAM response status ${status}`);
          return { ok: true, value: live.records, calls, notes };
        }
        return { ok: true, value: parseMockSegmentation(text, deps.decodeMask), calls };
      } catch (e) {
        return { ok: false, http: f.status, code: 'INVALID_MODEL_OUTPUT', detail: e instanceof Error ? e.message : String(e), calls };
      }
    },
  };
}
