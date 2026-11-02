// The owner's uploaded outfit photos. The browser sends two copies made from one canvas: a JPEG
// (long side ≤ 1600 px) that goes to the models, and a smaller PNG used here for pixel work (mask
// colour re-measure, cut-out thumbnails). Re-encoding in the browser drops EXIF and location.
// Files live next to the database, never in the repository, and can be deleted by the owner.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng, isPng, jpegSize, type Rgba } from '../engine/png.ts';
import type { PixelSource } from '../engine/color.ts';

export const MAX_LONG_SIDE = 1600;
export const MAX_JPEG_BYTES = 6 * 1024 * 1024;
export const MAX_PNG_LONG_SIDE = 1000;

export type UploadedPhoto = { photoId: string; workspaceId: string; w: number; h: number; url: string; pixels: PixelSource; png: Rgba; createdAt: string };
type Meta = { photoId: string; workspaceId: string; w: number; h: number; createdAt: string };

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

export class PhotoStore {
  readonly dir: string;
  private readonly cache = new Map<string, UploadedPhoto>();

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  /** Validates and stores one photo; returns its id. Throws with a reason the owner can act on. */
  save(workspaceId: string, jpeg: Buffer, png: Buffer, now: string): Meta {
    if (jpeg.length > MAX_JPEG_BYTES) throw new Error('photo over 6 MB; pick a smaller one');
    const size = jpegSize(jpeg);
    if (!size) throw new Error('not a JPEG');
    if (Math.max(size.w, size.h) > MAX_LONG_SIDE) throw new Error(`long side over ${MAX_LONG_SIDE} px`);
    if (!isPng(png)) throw new Error('pixel copy is not a PNG');
    const img = decodePng(png);
    if (Math.max(img.w, img.h) > MAX_PNG_LONG_SIDE) throw new Error(`pixel copy over ${MAX_PNG_LONG_SIDE} px`);
    if (Math.abs(img.w / img.h - size.w / size.h) > 0.02) throw new Error('the two copies have different shapes');
    const photoId = `up_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const meta: Meta = { photoId, workspaceId, w: size.w, h: size.h, createdAt: now };
    writeFileSync(join(this.dir, `${photoId}.jpg`), jpeg);
    writeFileSync(join(this.dir, `${photoId}.png`), png);
    writeFileSync(join(this.dir, `${photoId}.json`), JSON.stringify(meta));
    return meta;
  }

  get(photoId: string): UploadedPhoto | null {
    if (!/^up_[a-f0-9]{20}$/.test(photoId)) return null;
    const hit = this.cache.get(photoId);
    if (hit) return hit;
    const base = join(this.dir, photoId);
    if (!existsSync(`${base}.json`)) return null;
    const meta = JSON.parse(readFileSync(`${base}.json`, 'utf8')) as Meta;
    const png = decodePng(readFileSync(`${base}.png`));
    const photo: UploadedPhoto = {
      ...meta,
      url: `data:image/jpeg;base64,${readFileSync(`${base}.jpg`).toString('base64')}`,
      png,
      pixels: scaledPixels(png, meta.w, meta.h),
    };
    if (this.cache.size > 20) this.cache.clear();
    this.cache.set(photoId, photo);
    return photo;
  }

  jpegBytes(photoId: string): Buffer | null {
    const p = join(this.dir, `${photoId}.jpg`);
    return /^up_[a-f0-9]{20}$/.test(photoId) && existsSync(p) ? readFileSync(p) : null;
  }

  list(workspaceId: string): Meta[] {
    return readdirSync(this.dir).filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as Meta)
      .filter((m) => m.workspaceId === workspaceId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  delete(workspaceId: string, photoId: string): boolean {
    const m = this.list(workspaceId).find((x) => x.photoId === photoId);
    if (!m) return false;
    for (const ext of ['jpg', 'png', 'json']) rmSync(join(this.dir, `${photoId}.${ext}`), { force: true });
    this.cache.delete(photoId);
    return true;
  }
}
