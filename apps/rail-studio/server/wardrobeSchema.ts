import { inflateSync } from 'node:zlib';
import type { GarmentPiece } from '../src/types/closet.ts';
import { jpegSize } from './closer/engine/png.ts';
import { stripJpegMetadata } from './closer/store/photos.ts';

export const MAX_WARDROBE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const SEED_IDS = new Set(['J1', 'J2', 'T1', 'J3', 'T2', 'B1', 'J4', 'K1', 'T3', 'S1', 'P1', 'P2', 'F1', 'F2']);
const PLATFORMS = ['KREAM', 'Karrot', 'Bunjang', 'Musinsa Used', 'Poshmark', 'eBay', 'Grailed', 'Depop', 'StockX', 'Vinted'];
const CURRENCIES = ['KRW', 'USD'];
export class InvalidWardrobe extends Error {}
const fail = (): never => { throw new InvalidWardrobe('Some wardrobe records are invalid. Nothing was saved.'); };
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(k => !allowed.includes(k))) fail();
}
function string(value: unknown, max = 200, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) return fail();
  return value;
}
function number(value: unknown, max = 1e12, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max || (integer && !Number.isInteger(value))) return fail();
  return value;
}
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') return fail(); return value; }
function enumeration(value: unknown, allowed: readonly string[]): string {
  if (typeof value !== 'string' || !allowed.includes(value)) return fail(); return value;
}
function date(value: unknown, withTime = false): string {
  const s = string(value, 40);
  if (!(withTime ? /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z?)?$/ : /^\d{4}-\d{2}-\d{2}$/).test(s)) return fail();
  const iso = new Date(s.slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(iso.getTime()) || iso.toISOString().slice(0, 10) !== s.slice(0, 10) || !Number.isFinite(Date.parse(s))) return fail();
  return s;
}
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(bytes: Buffer) { let c = 0xffffffff; for (const b of bytes) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
/** Keep image chunks only, validate sizes/CRC and bound inflation before storing a PNG. */
function cleanPng(bytes: Buffer): Buffer {
  if (bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return fail();
  const parts = [bytes.subarray(0, 8)]; const compressed: Buffer[] = [];
  let offset = 8, width = 0, height = 0, channels = 0, ended = false, hasHeader = false;
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset), end = offset + size + 12;
    if (end > bytes.length) return fail();
    const kind = bytes.toString('ascii', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, end - 4);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return fail();
    if (!hasHeader && kind !== 'IHDR') return fail();
    if (kind === 'IHDR') {
      if (hasHeader || size !== 13) return fail();
      hasHeader = true; width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      if (!width || !height || width * height > 4_000_000 || body[8] !== 8 || ![2, 6].includes(body[9]) || body[10] || body[11] || body[12]) return fail();
      channels = body[9] === 6 ? 4 : 3;
    } else if (kind === 'IDAT') compressed.push(body);
    else if (kind === 'IEND') { if (size !== 0) return fail(); ended = true; }
    else if (kind !== 'PLTE' && kind !== 'tRNS' && (kind.charCodeAt(0) & 32) === 0) return fail();
    if (['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'].includes(kind)) parts.push(bytes.subarray(offset, end));
    offset = end;
    if (ended) break;
  }
  if (!ended || !compressed.length) return fail();
  const stride = width * channels + 1, expected = height * stride;
  try {
    const raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected });
    if (raw.length !== expected) return fail();
    for (let y = 0; y < height; y++) if (raw[y * stride] > 4) return fail();
  } catch { return fail(); }
  return Buffer.concat(parts);
}
function image(value: unknown): string {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 40) return fail();
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return fail();
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== match[2]) return fail();
  if (match[1] === 'png') return `data:image/png;base64,${cleanPng(bytes).toString('base64')}`;
  const dimensions = jpegSize(bytes);
  if (!dimensions || !dimensions.w || !dimensions.h || dimensions.w * dimensions.h > 4_000_000 || bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217) return fail();
  return `data:image/jpeg;base64,${stripJpegMetadata(bytes).toString('base64')}`;
}

function fees(raw: unknown) {
  const fee = record(raw); keys(fee,['platform','feeRatePct','shippingCost','feeRateConfirmed','shippingConfirmed','confirmed']);
  const parsed = { platform:enumeration(fee.platform,PLATFORMS),feeRatePct:number(fee.feeRatePct,100),shippingCost:number(fee.shippingCost),confirmed:boolean(fee.confirmed),
    ...(fee.feeRateConfirmed !== undefined ? {feeRateConfirmed:boolean(fee.feeRateConfirmed)} : {}), ...(fee.shippingConfirmed !== undefined ? {shippingConfirmed:boolean(fee.shippingConfirmed)} : {}) };
  if (fee.confirmed !== (fee.feeRateConfirmed === true && fee.shippingConfirmed === true)) return fail();
  return parsed;
}

function piece(raw: unknown): GarmentPiece {
  const g = record(raw);
  keys(g, ['id','code','name','brand','category','silhouette','currency','purchasePrice','isSample','colorHex','secondaryColorHex','fabricLabel','hangerType','wearsLast60Days','wearLogStatus','lastWornDate','conditionGrade','upcomingOccasions','lockedForToday','occlusionStatus','imageUrl','frontImageUrl','cutoutSource','scanMode','scanReceiptId','scanCardId','scanColor','observations','feeConfig','lastDecision']);
  const id = string(g.id, 120);
  if (!/^(scan-|piece-custom-)[A-Za-z0-9_-]+$/.test(id) || SEED_IDS.has(id.toUpperCase()) || g.isSample !== false || g.scanMode === 'fake') return fail();
  const out: Record<string, unknown> = {
    id, code:string(g.code,40), name:string(g.name,300), brand:string(g.brand,200,true),
    category:enumeration(g.category,['outerwear','blazer','hoodie','knitwear','shirt','trousers','footwear']),
    silhouette:enumeration(g.silhouette,['overcoat','blazer','hoodie','blouson','knit','tee','trousers','sneaker-box']),
    currency:enumeration(g.currency,CURRENCIES), purchasePrice:g.purchasePrice === null ? null : number(g.purchasePrice),
    isSample:false, fabricLabel:string(g.fabricLabel,300,true), hangerType:enumeration(g.hangerType,['walnut-brass','brushed-brass','matte-black']),
    wearsLast60Days:number(g.wearsLast60Days,100000,true),
  };
  for (const key of ['colorHex','secondaryColorHex']) { if (typeof g[key] !== 'string' || !/^#[A-Fa-f0-9]{6}$/.test(g[key] as string)) return fail(); out[key] = g[key]; }
  const enums: Record<string,string[]> = {wearLogStatus:['verified','insufficient'],conditionGrade:['Mint (S)','Excellent (A+)','Good (A)'],occlusionStatus:['front_verified','side_occluded'],cutoutSource:['sam-mask','box-crop'],scanMode:['live']};
  for (const [key, allowed] of Object.entries(enums)) if (g[key] !== undefined) out[key] = enumeration(g[key], allowed);
  for (const key of ['scanReceiptId','scanCardId']) {
    if (g[key] !== undefined) {
      const value = string(g[key], 128);
      if (!/^[A-Za-z0-9_-]+$/.test(value)) return fail();
      out[key] = value;
    }
  }
  if (g.scanColor !== undefined) {
    if (!g.scanReceiptId) return fail();
    out.scanColor = enumeration(g.scanColor,['black','charcoal','gray','white','beige','brown','navy','blue','green','red','yellow','pink','unknown']);
  }
  if ((g.scanReceiptId === undefined) !== (g.scanCardId === undefined)) return fail();
  if (g.scanReceiptId !== undefined && g.scanMode !== 'live') return fail();
  if (g.lastWornDate !== undefined) out.lastWornDate = g.lastWornDate === null ? null : date(g.lastWornDate);
  if (g.lockedForToday !== undefined) out.lockedForToday = boolean(g.lockedForToday);
  if (g.upcomingOccasions !== undefined) {
    if (!Array.isArray(g.upcomingOccasions) || g.upcomingOccasions.length > 50) return fail();
    out.upcomingOccasions = g.upcomingOccasions.map(v => string(v, 300));
  }
  for (const key of ['imageUrl','frontImageUrl']) if (g[key] !== undefined) out[key] = image(g[key]);
  if (!Array.isArray(g.observations) || g.observations.length > 1000) return fail();
  const seen = new Set<string>();
  out.observations = g.observations.map(raw => {
    const p = record(raw); keys(p,['id','date','platform','price','currency','kind','isSample']);
    const pid = string(p.id,120); if (seen.has(pid) || p.isSample === true || (p.isSample !== undefined && p.isSample !== false)) return fail(); seen.add(pid);
    if (p.currency !== g.currency) return fail();
    return { id:pid, date:date(p.date), platform:enumeration(p.platform,PLATFORMS), price:number(p.price), currency:enumeration(p.currency,CURRENCIES), kind:enumeration(p.kind,['traded','listed']), ...(p.isSample === false ? {isSample:false}: {}) };
  });
  out.feeConfig = fees(g.feeConfig);
  if (g.lastDecision !== undefined) {
    const d = record(g.lastDecision); keys(d,['id','choice','savedAt','snapshotPrice','snapshotCurrency','snapshotPlatform','feeSnapshot','note']);
    if (d.snapshotCurrency !== g.currency) return fail();
    out.lastDecision = {id:string(d.id,120), choice:enumeration(d.choice,['keep','sell']),savedAt:date(d.savedAt,true),snapshotPrice:number(d.snapshotPrice),snapshotCurrency:enumeration(d.snapshotCurrency,CURRENCIES),snapshotPlatform:enumeration(d.snapshotPlatform,PLATFORMS), ...(d.feeSnapshot !== undefined ? {feeSnapshot:fees(d.feeSnapshot)} : {}), ...(d.note !== undefined ? {note:string(d.note,2000,true)}:{})};
  }
  return out as unknown as GarmentPiece;
}
export function validateWardrobe(raw: unknown): GarmentPiece[] {
  if (!Array.isArray(raw) || raw.length > 200 || Buffer.byteLength(JSON.stringify(raw),'utf8') > MAX_WARDROBE_BYTES) return fail();
  const ids = new Set<string>();
  return raw.map(g => { const p = piece(g); if (ids.has(p.id)) return fail(); ids.add(p.id); return p; });
}
