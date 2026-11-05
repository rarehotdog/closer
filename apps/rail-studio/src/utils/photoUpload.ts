import type { GarmentPiece } from '../types/closet';

/** Re-encode a local photo before account storage: bounded pixels, no camera metadata. */
export async function preparePhotoUrl(dataUrl: string): Promise<string> {
  if (!/^data:image\/(png|jpeg|webp);base64,/i.test(dataUrl)) {
    throw new Error('Choose a JPEG, PNG or WebP photo.');
  }
  if (dataUrl.length > 28 * 1024 * 1024) throw new Error('Choose a photo smaller than 20 MB.');
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40_000_000) {
      throw new Error('Choose a smaller photo.');
    }
    const transparent = blob.type === 'image/png';
    let maxSide = 1280;
    for (let attempt = 0; attempt < 4; attempt++) {
      const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('This browser could not prepare the photo.');
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const result = canvas.toDataURL(transparent ? 'image/png' : 'image/jpeg', 0.88);
      if (result.length <= 4 * 1024 * 1024) return result;
      maxSide = Math.floor(maxSide * 0.7);
    }
    throw new Error('This photo is too large to save. Choose a smaller image.');
  } finally {
    bitmap.close();
  }
}

export async function preparePiecePhotos(piece: GarmentPiece): Promise<GarmentPiece> {
  const copy = { ...piece };
  const encoded = new Map<string, string>();
  for (const field of ['imageUrl', 'frontImageUrl'] as const) {
    const source = piece[field];
    if (!source) continue;
    if (!encoded.has(source)) encoded.set(source, await preparePhotoUrl(source));
    copy[field] = encoded.get(source);
  }
  return copy;
}
