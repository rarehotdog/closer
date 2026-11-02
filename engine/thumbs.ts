// Mask cut-out thumbnails for Spark 2 (§3-3: long side 256 px). Pixels outside the SAM mask are
// transparent, so the model sees the garment, not the room or the person around it.
import { decodeMockRle } from './coords.ts';
import { encodePng } from './png.ts';
import type { PixelSource } from './color.ts';

export const THUMB_LONG_SIDE = 256;
/** Thumbnails per Spark 2 call [가정: cost and latency cap]. */
export const MAX_THUMBNAILS = 8;

export type StoredMask = { x: number; y: number; w: number; h: number; rle: string };

export function cutoutPng(pixels: PixelSource, mask: StoredMask, longSide = THUMB_LONG_SIDE): Buffer {
  const bits = decodeMockRle(mask.rle, mask.w * mask.h);
  const scale = Math.min(1, longSide / Math.max(mask.w, mask.h));
  const tw = Math.max(1, Math.round(mask.w * scale));
  const th = Math.max(1, Math.round(mask.h * scale));
  const data = new Uint8Array(tw * th * 4);
  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      const mx = Math.min(mask.w - 1, Math.floor(tx / scale));
      const my = Math.min(mask.h - 1, Math.floor(ty / scale));
      const j = (ty * tw + tx) * 4;
      if (!bits[my * mask.w + mx]) continue; // stays transparent
      const [r, g, b] = pixels.rgbAt(mask.x + mx, mask.y + my);
      data[j] = r; data[j + 1] = g; data[j + 2] = b; data[j + 3] = 255;
    }
  }
  return encodePng({ w: tw, h: th, data });
}
