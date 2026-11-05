// Trimmed copy of closer store/photos.ts at dba9ff3 (github.com/rarehotdog/closer): only what photo -> cards needs.
import type { Rgba } from '../engine/png.ts';
import type { PixelSource } from '../engine/color.ts';

/** JPEG segments that carry metadata rather than picture data: APP1 (Exif, XMP), APP13 (IPTC) and comments. */
const METADATA_SEGMENTS = new Set([0xe1, 0xed, 0xfe]);
const EXIF_MARK = Buffer.from('Exif\0\0', 'latin1');

/**
 * Copies a JPEG without its APP1 (Exif/XMP), APP13 (IPTC) and COM segments. The scan and the
 * segments a decoder needs (APP0 JFIF, APP2 ICC, APP14 Adobe, tables, frame headers) are kept
 * byte for byte, so the picture is unchanged. Bytes that are not a JPEG come back as they were.
 */
export function stripJpegMetadata(buf: Buffer): Buffer {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return buf;
  const parts: Buffer[] = [buf.subarray(0, 2)];
  let i = 2;
  while (i + 1 < buf.length && buf[i] === 0xff) {
    const m = buf[i + 1];
    if (m === 0xff) {
      i += 1; // fill byte before a marker
      continue;
    }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      parts.push(buf.subarray(i, i + 2)); // stand-alone markers carry no length
      i += 2;
      continue;
    }
    if (m === 0xda || m === 0xd9 || i + 4 > buf.length) break; // start of scan or end of image: the rest is copied as is
    const end = i + 2 + buf.readUInt16BE(i + 2);
    if (!METADATA_SEGMENTS.has(m)) parts.push(buf.subarray(i, Math.min(end, buf.length)));
    i = end;
  }
  parts.push(buf.subarray(Math.min(i, buf.length)));
  return Buffer.concat(parts);
}

/** Map photo coordinates onto the smaller PNG copy. */
export function scaledPixels(png: Rgba, w: number, h: number): PixelSource {
  const sx = png.w / w, sy = png.h / h;
  return {
    w, h,
    rgbAt(x: number, y: number) {
      const px = Math.min(png.w - 1, Math.max(0, Math.floor(x * sx)));
      const py = Math.min(png.h - 1, Math.max(0, Math.floor(y * sy)));
      const i = (py * png.w + px) * 4;
      return [png.data[i], png.data[i + 1], png.data[i + 2]] as const;
    },
  };
}
