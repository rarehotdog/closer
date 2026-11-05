// 실호출 기록: docs/live/live_check.json (2026-11-05, 1회) — 그 기록 밖의 응답 형태는 문서 예시 기반
// Official SAM mask decoder (@meta-sam/parser, SAM License). The wire marker is the first character
// after "H,W,": '~' lossless (default for text prompts), '!' one_bit (box and point prompts always).
// The library expects the marker as part of the payload. Decoded against the docs' own example in
// tests/unit (27×60 lossless mask).
import { decodeMaskToRaster } from '@meta-sam/parser';
import type { MaskDecoder } from './sam.ts';

export const officialMaskDecoder: MaskDecoder = (wire) => {
  const encoding = wire.enc === '~' ? 'lossless' : wire.enc === '!' ? 'one_bit' : null;
  if (!encoding) throw new Error(`unknown mask encoding marker '${wire.enc}'`);
  return decodeMaskToRaster({ encoding, payload: wire.enc + wire.payload, width: wire.w, height: wire.h });
};
