// 미검증 — 문서 예시 기반, 실호출 0
// SAM 3.1: same image + box prompts (object IDs 1–n chosen by code) in one request → one box and
// one mask per ID. Non-streaming (streaming is optional per the SAM docs). store:false (§3-4).
import { decodeMockRle, parseSegmentation, type MaskRaster, type SamMaskWire } from '../engine/coords.ts';
import { statusToReason } from '../engine/retry.ts';
import type { SamRecord } from '../engine/validate.ts';
import { callResponses, EST_MICRO_USD, outputText, SAM_IMAGE_MICRO_USD, SAM_MODEL, type CallDeps } from './responses.ts';
import type { SamPort, SamRequest } from './types.ts';

export function buildSamBody(req: SamRequest): Record<string, unknown> {
  return {
    model: SAM_MODEL,
    store: false,
    // Box prompts always come back one_bit; asking for it keeps the request explicit (segmenting doc).
    metadata: { mask_encoding: 'one_bit' },
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
 * Decoder for the documented mask encodings ('~' lossless, '!' one_bit). Production uses the
 * official client library (adapters/samDecoder.ts); the mock transport's own 'R' run-length
 * encoding is decoded here.
 */
export type MaskDecoder = (wire: SamMaskWire) => Uint8Array;

export function createSamPort(deps: CallDeps & { decodeMask?: MaskDecoder }): SamPort {
  return {
    async segment(req) {
      const { outcome, calls } = await callResponses(deps, buildSamBody(req), {
        model: SAM_MODEL,
        estMicroUsd: EST_MICRO_USD.sam,
        price: () => SAM_IMAGE_MICRO_USD,
      });
      const f = outcome.final;
      if (!f || f.status < 200 || f.status >= 300) {
        const status = f?.status ?? 0;
        return { ok: false, http: status, code: statusToReason(status), detail: `SAM HTTP ${status}`, calls };
      }
      const text = outputText(f.json) ?? '';
      const records: SamRecord[] = [];
      try {
        for (const w of parseSegmentation(text)) {
          let raster: MaskRaster | null = null;
          if (w.mask) {
            const size = w.mask.h * w.mask.w;
            let bits: Uint8Array;
            if (w.mask.enc === 'R') bits = decodeMockRle(w.mask.payload, size);
            else if (deps.decodeMask) bits = deps.decodeMask(w.mask);
            else throw new Error(`no decoder for mask encoding '${w.mask.enc}'`);
            raster = { x: w.box.x1, y: w.box.y1, w: w.mask.w, h: w.mask.h, bits };
          }
          records.push({ id: w.id, box: w.box, frameW: w.frameW, frameH: w.frameH, raster });
        }
      } catch (e) {
        return { ok: false, http: f.status, code: 'INVALID_MODEL_OUTPUT', detail: e instanceof Error ? e.message : String(e), calls };
      }
      return { ok: true, value: records, calls };
    },
  };
}
