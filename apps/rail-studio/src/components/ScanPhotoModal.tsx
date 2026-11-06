import React, { useEffect, useRef, useState } from 'react';
import { Camera, Check, Loader2, X } from 'lucide-react';
import { GarmentCategory, GarmentPiece, GarmentSilhouette } from '../types/closet';
import { mergeTileFinds, tileRects, type Rect } from '../utils/tiles';

// One photo -> garment cards -> pieces on the rail. The photo goes to this app's own server
// (server.ts, POST /api/scan), which calls muse-spark-1.3 and sam-3.1 with the key it holds; the
// browser never sees a key. Nothing is added to the closet until the owner confirms the cards.

export type ScanMode = 'live' | 'fake' | 'no_key' | 'off';
export type CallLine = { model: string; http: number; latencyMs: number; source: string };
export type ScanCard = {
  cardId: number;
  scanReceiptId?: string;
  scanCardId?: string;
  slot: string;
  type: string;
  sparkColor: string;
  maskColor: string | null;
  formality: string;
  pinned: boolean;
  offender: string | null;
  colorChoices: [string, string] | null;
  cutout: string;
  cutoutKind: 'mask' | 'box_crop';
  /** Pixels of the image that was sent (x2/y2 inclusive). */
  box: Rect;
};
export type ScanKind = 'outfit' | 'closet';
export type ScanOk = { ok: true; receiptId?: string; kind: ScanKind; cards: ScanCard[]; direction: string; moreNotListed: boolean | null; samMode: 'mask' | 'box_crop'; notes: string[]; calls: CallLine[]; mode: ScanMode; w: number; h: number };
export type ScanFail = { ok: false; code: string; detail: string; calls?: CallLine[]; mode?: ScanMode };

/** Missing transport evidence is unknown, not proof that no paid request happened. */
export function scanAttempted(failure: ScanFail): boolean | null {
  if (failure.calls?.length) return true;
  if (failure.mode === 'fake') return false;
  return ['META_DISABLED','META_KEY_MISSING','SESSION_REQUIRED','ORIGIN_DENIED','ACCOUNT_CHANGED','CALL_CAP_REACHED','BAD_INPUT'].includes(failure.code) ? false : null;
}

export function samplePreviewOnly(fromSample: boolean, workspaceId?: string | null): boolean {
  return fromSample && !!workspaceId;
}

export function cutoutSummary(cards: Pick<ScanCard, 'cutoutKind'>[]): string {
  const masks = cards.filter(card => card.cutoutKind === 'mask').length;
  const crops = cards.length - masks;
  if (!cards.length) return 'No garment cut-outs';
  if (!crops) return `${masks} SAM mask${masks === 1 ? '' : 's'}`;
  if (!masks) return `${crops} box crop${crops === 1 ? '' : 's'} (no masks)`;
  return `${masks} SAM mask${masks === 1 ? '' : 's'} · ${crops} box crop${crops === 1 ? '' : 's'}`;
}

export const NAMED_HEX: Record<string, string> = {
  black: '#141416', charcoal: '#3A3C42', gray: '#808082', white: '#F0F0EC', beige: '#D4C2A0', brown: '#704C32',
  navy: '#1E2852', blue: '#2C5CAA', green: '#3E7A48', red: '#B42A2E', yellow: '#E2C43E', pink: '#E8A2B6', unknown: '#9A958C',
};
const SLOT_PREFIX: Record<string, string> = { outer: 'J', top: 'T', bottom: 'B', shoes: 'S' };
export const SHAPE: Record<string, [GarmentSilhouette, GarmentCategory]> = {
  jacket: ['blazer', 'blazer'], coat: ['overcoat', 'outerwear'], track_jacket: ['blouson', 'outerwear'],
  knit: ['knit', 'knitwear'], hoodie: ['hoodie', 'hoodie'], training_top: ['hoodie', 'hoodie'], tee: ['tee', 'shirt'], dress_shirt: ['tee', 'shirt'], blouse: ['tee', 'shirt'],
  trousers: ['trousers', 'trousers'], jeans: ['trousers', 'trousers'], chinos: ['trousers', 'trousers'], joggers: ['trousers', 'trousers'], shorts: ['trousers', 'trousers'], skirt: ['trousers', 'trousers'],
  sneakers: ['sneaker-box', 'footwear'], derby: ['sneaker-box', 'footwear'], running_shoes: ['sneaker-box', 'footwear'], loafers: ['sneaker-box', 'footwear'],
};
const WHY: Record<string, string> = { too_formal: 'feels too formal', too_casual: 'feels too casual', color_clash: 'colour clashes', weather: 'wrong for the weather' };
const DIRECTION: Record<string, string> = { less_formal: 'less formal', more_formal: 'more formal', warmer: 'warmer', cooler: 'cooler', none: 'no change asked' };
const label = (t: string) => t.replace(/_/g, ' ');

/** Two copies from one canvas: JPEG (long side <= 1600) for the models, PNG (<= 800) for pixel work. Drops EXIF. */
export async function prepare(file: File) {
  const bmp = await createImageBitmap(file);
  const draw = (max: number, type: string, q?: number) => {
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL(type, q);
  };
  try {
    return { jpeg: draw(1600, 'image/jpeg', 0.9), png: draw(800, 'image/png') };
  } finally { bmp.close(); }
}

/** One part of the photo at full resolution, encoded like prepare(). k = scale of the JPEG that was sent. */
async function preparePart(bmp: ImageBitmap, r: Rect) {
  const pw = r.x2 - r.x1 + 1;
  const ph = r.y2 - r.y1 + 1;
  const draw = (max: number, type: string, q?: number) => {
    const k = Math.min(1, max / Math.max(pw, ph));
    const c = document.createElement('canvas');
    c.width = Math.round(pw * k);
    c.height = Math.round(ph * k);
    c.getContext('2d')!.drawImage(bmp, r.x1, r.y1, pw, ph, 0, 0, c.width, c.height);
    return { url: c.toDataURL(type, q), k };
  };
  const j = draw(1600, 'image/jpeg', 0.9);
  return { jpeg: j.url, png: draw(800, 'image/png').url, k: j.k };
}

/** A box in the pixels of an image sent at scale k, back in the original photo's pixels. */
const toPhoto = (b: Rect, k: number, off: { x1: number; y1: number }): Rect => ({
  x1: Math.round(b.x1 / k) + off.x1,
  y1: Math.round(b.y1 / k) + off.y1,
  x2: Math.round(b.x2 / k) + off.x1,
  y2: Math.round(b.y2 / k) + off.y1,
});

export function modeLine(mode: ScanMode | null): string {
  if (mode === 'live') return 'Meta ready · muse-spark-1.3 + sam-3.1';
  if (mode === 'fake') return 'Test fake · no Meta call';
  if (mode === 'no_key') return 'No Meta key on this server · scanning is off';
  if (mode === 'off') return 'Model calls switched off on this server';
  return 'Checking the server…';
}

/** Turns confirmed cards into closet pieces. No price, wear, fee or decision is invented. */
// Sample photos from the design kit (studio shots of one garment each), for trying the scan without
// a photo of your own. Pieces scanned from them are marked Sample, like the sample closet.
const SAMPLE_SHOTS = ['front_cashmere_coat_1793835552741', 'front_tailored_blazer_1793835553313', 'front_heavy_hoodie_1793835551654', 'front_leather_blouson_1793835550605'].map((n) => `/src/assets/images/${n}.jpg`);
async function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}
/** Outfit mode: one studio shot. Closet mode: the four shots side by side, like a rail. */
export async function sampleFile(kind: 'outfit' | 'closet'): Promise<File> {
  if (kind === 'outfit') {
    const blob = await (await fetch(SAMPLE_SHOTS[1])).blob();
    return new File([blob], 'sample-blazer.jpg', { type: blob.type || 'image/jpeg' });
  }
  const imgs = await Promise.all(SAMPLE_SHOTS.map(loadImage));
  const h = 900;
  const widths = imgs.map((i) => Math.round((i.naturalWidth * h) / i.naturalHeight));
  const c = document.createElement('canvas');
  c.width = widths.reduce((a, b) => a + b, 0);
  c.height = h;
  const x = c.getContext('2d')!;
  x.fillStyle = '#FFFFFF';
  x.fillRect(0, 0, c.width, c.height);
  let at = 0;
  imgs.forEach((img, i) => {
    x.drawImage(img, at, 0, widths[i], h);
    at += widths[i];
  });
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('canvas export failed'))), 'image/jpeg', 0.9));
  return new File([blob], 'sample-rail.jpg', { type: 'image/jpeg' });
}

export function receiptCards(result: ScanOk): ScanCard[] {
  if (result.mode !== 'live') return result.cards;
  if (!result.receiptId || !/^[A-Za-z0-9_-]{1,128}$/.test(result.receiptId)) {
    throw new Error('The server did not return a scan receipt. No pieces were added.');
  }
  return result.cards.map(card => ({ ...card, scanReceiptId: result.receiptId, scanCardId: String(card.cardId) }));
}

export function cardsToPieces(cards: ScanCard[], chosen: Record<number, string>, mode: 'live' | 'fake', existing: GarmentPiece[], stamp: number, sample = false): GarmentPiece[] {
  const used = new Set(existing.map((g) => g.code));
  const next = (prefix: string) => {
    let n = 1;
    while (used.has(`${prefix}${n}`)) n++;
    used.add(`${prefix}${n}`);
    return `${prefix}${n}`;
  };
  return cards.map((c) => {
    const color = chosen[c.cardId] ?? c.maskColor ?? c.sparkColor;
    const [silhouette, category] = SHAPE[c.type] ?? ['tee', 'shirt'];
    return {
      id: `scan-${stamp}-${c.cardId}`,
      code: next(SLOT_PREFIX[c.slot] ?? 'A'),
      name: `${color === 'unknown' ? '' : `${color} `}${label(c.type)}`,
      brand: '',
      category,
      silhouette,
      currency: 'KRW',
      purchasePrice: null,
      isSample: sample,
      colorHex: NAMED_HEX[color] ?? NAMED_HEX.unknown,
      secondaryColorHex: NAMED_HEX[color] ?? NAMED_HEX.unknown,
      fabricLabel: 'Fabric not entered',
      hangerType: 'walnut-brass',
      wearsLast60Days: 0,
      wearLogStatus: 'insufficient',
      lastWornDate: null,
      lockedForToday: false,
      imageUrl: c.cutout,
      frontImageUrl: c.cutout,
      cutoutSource: c.cutoutKind === 'mask' ? 'sam-mask' : 'box-crop',
      scanMode: mode,
      ...(mode === 'live' && c.scanReceiptId ? { scanReceiptId: c.scanReceiptId, scanCardId: c.scanCardId ?? String(c.cardId), scanColor: color } : {}),
      observations: [],
      feeConfig: { platform: 'Karrot', feeRatePct: 0, shippingCost: 0, confirmed: false },
    } satisfies GarmentPiece;
  });
}

interface ScanPhotoModalProps {
  isOpen: boolean;
  onClose: () => void;
  garments: GarmentPiece[];
  onHang: (pieces: GarmentPiece[]) => void;
  workspaceId?: string | null;
}

export const ScanPhotoModal: React.FC<ScanPhotoModalProps> = ({ isOpen, onClose, garments, onHang, workspaceId = null }) => {
  const [mode, setMode] = useState<ScanMode | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fromSample, setFromSample] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [sentence, setSentence] = useState('');
  const [kind, setKind] = useState<ScanKind>('outfit');
  const [busy, setBusy] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  const [partsDone, setPartsDone] = useState(false);
  const [result, setResult] = useState<ScanOk | null>(null);
  const [failure, setFailure] = useState<ScanFail | null>(null);
  const [keep, setKeep] = useState<Record<number, boolean>>({});
  const [chosen, setChosen] = useState<Record<number, string>>({});
  const inputRef = useRef<HTMLInputElement | null>(null);
  const scanToken = useRef(0);
  const identity = useRef({ workspaceId, isOpen });
  identity.current = { workspaceId, isOpen };
  useEffect(() => {
    scanToken.current++;
    setResult(null); setFailure(null); setKeep({}); setChosen({});
    setFile(null); setPreview(null); setSentence(''); setFromSample(false);
    setBusy(false); setMoreBusy(false); setPartsDone(false);
    return () => { scanToken.current++; };
  }, [workspaceId, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    let gone = false;
    fetch('/api/scan/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!gone) setMode(j && typeof j.mode === 'string' ? (j.mode as ScanMode) : 'no_key'); })
      .catch(() => { if (!gone) setMode('no_key'); });
    return () => { gone = true; };
  }, [isOpen]);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  if (!isOpen) return null;

  const reset = () => {
    setPartsDone(false);
    setResult(null);
    setFailure(null);
    setKeep({});
    setChosen({});
  };
  const pick = (f: File | null, sample = false) => {
    scanToken.current++; setBusy(false); setMoreBusy(false);
    setFromSample(sample && !!f);
    reset();
    setFile(f);
    setPreview(f ? URL.createObjectURL(f) : null);
  };
  const scan = async () => {
    if (!file || samplePreviewOnly(fromSample, workspaceId) || (mode === 'live' && !workspaceId)) return;
    const token = ++scanToken.current;
    const current = () => token === scanToken.current && identity.current.isOpen && identity.current.workspaceId === workspaceId;
    setBusy(true);
    reset();
    try {
      const { jpeg, png } = await prepare(file);
      if (!current()) return;
      const res = await fetch('/api/scan', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId, jpegBase64: jpeg, pngBase64: png, sentence: kind === 'outfit' ? sentence : '', mode: kind }) });
      const j = (await res.json().catch(() => null)) as ScanOk | ScanFail | null;
      if (!current()) return;
      if (!j) setFailure({ ok: false, code: 'NO_ANSWER', detail: `the server answered ${res.status} without a body` });
      else if (j.ok) {
        setResult({ ...j, cards: receiptCards(j) });
        setKeep(Object.fromEntries(j.cards.filter((c) => c.slot !== 'shoes').map((c) => [c.cardId, true])));
        if (j.mode) setMode(j.mode);
      } else {
        setFailure(j);
        if (j.mode) setMode(j.mode);
      }
    } catch (e) {
      if (current()) setFailure({ ok: false, code: 'NETWORK', detail: e instanceof Error ? e.message : String(e) });
    } finally {
      if (current()) setBusy(false);
    }
  };
  // Closet photos with more than one scan can list: scan two overlapping parts at full resolution
  // and merge, keeping one card per garment (the larger box when two parts saw the same piece).
  const scanRest = async () => {
    if (!file || !result || samplePreviewOnly(fromSample, workspaceId) || (mode === 'live' && !workspaceId)) return;
    const token = ++scanToken.current;
    const current = () => token === scanToken.current && identity.current.isOpen && identity.current.workspaceId === workspaceId;
    setMoreBusy(true);
    try {
      const bmp = await createImageBitmap(file);
      const W = bmp.width;
      const H = bmp.height;
      const k0 = Math.min(1, 1600 / Math.max(W, H));
      const tiles = W >= H ? tileRects(W, H, 2, 1) : tileRects(W, H, 1, 2);
      const finds: { card: ScanCard; box: Rect; first: boolean }[] = result.cards.map((card) => ({ card, box: toPhoto(card.box, k0, { x1: 0, y1: 0 }), first: true }));
      const calls = [...result.calls];
      const notes = [...result.notes];
      let failed = 0;
      for (const t of tiles) {
        if (!current()) { bmp.close(); return; }
        const part = await preparePart(bmp, t);
        if (!current()) { bmp.close(); return; }
        const res = await fetch('/api/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ workspaceId, jpegBase64: part.jpeg, pngBase64: part.png, sentence: '', mode: 'closet' }) });
        const j = (await res.json().catch(() => null)) as ScanOk | ScanFail | null;
        if (!current()) { bmp.close(); return; }
        if (j?.calls) calls.push(...j.calls);
        if (!j || !j.ok) {
          failed++;
          continue;
        }
        for (const card of receiptCards(j)) finds.push({ card, box: toPhoto(card.box, part.k, t), first: false });
        for (const n of j.notes) if (!n.includes('more garments than it listed') && !notes.includes(n)) notes.push(n);
      }
      bmp.close();
      if (!current()) return;
      const kept = mergeTileFinds(finds);
      let next = Math.max(0, ...result.cards.map((c) => c.cardId)) + 1;
      const stay = result.cards.filter((c) => kept.some((k) => k.first && k.card === c));
      const added = kept.filter((k) => !k.first).map((k) => ({ ...k.card, cardId: next++ }));
      notes.push(`Scanned the photo again in ${tiles.length} overlapping parts: ${added.length} more piece${added.length === 1 ? '' : 's'} found${failed ? `; ${failed} part${failed === 1 ? '' : 's'} could not be scanned` : ''}.`);
      setKeep((s) => ({ ...s, ...Object.fromEntries(added.filter((c) => c.slot !== 'shoes').map((c) => [c.cardId, true])) }));
      setResult({ ...result, cards: [...stay, ...added], calls, notes });
      setPartsDone(true);
    } catch (e) {
      if (current()) setFailure({ ok: false, code: 'PARTS_FAILED', detail: e instanceof Error ? e.message : String(e) });
    } finally {
      if (current()) setMoreBusy(false);
    }
  };
  const open = result ? result.cards.filter((c) => keep[c.cardId] && c.colorChoices && !chosen[c.cardId]) : [];
  const picked = result ? result.cards.filter((c) => keep[c.cardId]) : [];
  const hang = () => {
    if (!result || samplePreviewOnly(fromSample, workspaceId) || picked.length === 0 || open.length > 0) return;
    onHang(cardsToPieces(picked, chosen, result.mode === 'live' ? 'live' : 'fake', garments, Date.now(), fromSample));
    pick(null);
    setSentence('');
    onClose();
  };
  const live = mode === 'live';
  const previewOnly = samplePreviewOnly(fromSample, workspaceId);
  const canScan = !!file && !previewOnly && !busy && !moreBusy && ((mode === 'live' && !!workspaceId) || mode === 'fake');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#141413]/40 p-4" role="dialog" aria-modal="true" aria-labelledby="scan-title">
      <div className="w-full max-w-3xl max-h-[92vh] overflow-y-auto bg-white rounded-2xl shadow-2xl border border-[#E7E2DA]">
        <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-3 border-b border-[#E7E2DA]">
          <div>
            <h2 id="scan-title" className="font-serif text-2xl text-[#141413]">Start with one photo</h2>
            <p className="text-xs text-[#6B665E] mt-1">Each garment in the photo becomes a card. Nothing joins your closet until you confirm.</p>
            <div className="mt-2 inline-flex rounded-lg border border-[#E7E2DA] overflow-hidden text-[11px] font-semibold" role="group" aria-label="What the photo shows" data-testid="scan-kind">
              {(['outfit', 'closet'] as const).map((k) => (
                <button key={k} type="button" aria-pressed={kind === k} onClick={() => { scanToken.current++; setBusy(false); setMoreBusy(false); setKind(k); reset(); }} className={`px-3 py-1.5 ${kind === k ? 'bg-[#141413] text-white' : 'bg-white text-[#141413] hover:bg-[#F6F3EE]'}`}>
                  {k === 'outfit' ? 'One outfit' : 'Closet or rail (up to 16)'}
                </button>
              ))}
            </div>
            <p className={`mt-2 inline-block text-[11px] font-mono px-2 py-0.5 rounded border ${live ? 'border-[#F37021] text-[#B8460F]' : 'border-dashed border-[#B8B2A7] text-[#6B665E]'}`} data-testid="scan-mode">{modeLine(mode)}</p>
          </div>
          <button type="button" onClick={onClose} className="p-2 rounded-lg hover:bg-[#F6F3EE]" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>

        <div className="px-6 py-5 grid gap-5 md:grid-cols-[220px_1fr]">
          <div className="flex flex-col gap-3">
            {live && !workspaceId && <p className="text-xs text-[#B8460F]" role="status">Sign in to scan with Meta and save the results to your wardrobe. You can still explore the sample closet.</p>}
            <button type="button" onClick={() => inputRef.current?.click()} className="aspect-[3/4] w-full rounded-xl border-2 border-dashed border-[#D9D3C9] bg-[#FAF8F4] flex flex-col items-center justify-center gap-2 overflow-hidden hover:border-[#F37021]" data-testid="scan-pick">
              {preview ? <img src={preview} alt="Chosen photo" className="w-full h-full object-cover" /> : (<><Camera className="w-6 h-6 text-[#B8460F]" /><span className="text-sm font-semibold text-[#141413]">Take or choose a photo</span><span className="text-[11px] text-[#6B665E]">one outfit, front on</span></>)}
            </button>
            <input ref={inputRef} type="file" accept="image/*" capture="environment" className="hidden" data-testid="scan-file" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
            <button
              type="button"
              data-testid="scan-sample"
              onClick={() => { sampleFile(kind).then((f) => pick(f, true)).catch(() => setFailure({ ok: false, code: 'SAMPLE_UNAVAILABLE', detail: 'the sample photo could not be loaded' })); }}
              className="text-[11px] text-[#B8460F] underline underline-offset-2 text-left"
            >
              {kind === 'outfit' ? 'Or try a sample photo (a blazer)' : 'Or try a sample rail (4 pieces)'}
            </button>
            {fromSample && <span className="text-[10px] text-[#6B665E]" role="status">{previewOnly ? 'Sample preview only · no Meta call. Choose your own photo to scan and save to your wardrobe.' : 'Sample photo from the design kit: pieces from it are marked Sample.'}</span>}
            {kind === 'outfit' && (
              <>
                <label className="text-[11px] font-semibold uppercase tracking-wider text-[#6B665E]" htmlFor="scan-sentence">What feels off? (optional)</label>
                <input id="scan-sentence" value={sentence} maxLength={200} onChange={(e) => setSentence(e.target.value)} placeholder="Keep this jacket. The rest feels too dressed-up." className="w-full text-sm px-3 py-2 rounded-lg border border-[#E7E2DA] focus:outline-none focus:border-[#F37021]" />
              </>
            )}
            <button type="button" onClick={scan} disabled={!canScan} className="w-full px-4 py-2.5 text-sm font-semibold rounded-lg bg-[#F37021] text-[#141413] disabled:opacity-40 inline-flex items-center justify-center gap-2" data-testid="scan-go">
              {busy ? <><Loader2 className="w-4 h-4 animate-spin" />Finding the pieces…</> : 'Find the pieces'}
            </button>
          </div>

          <div className="min-h-[260px]">
            {!result && !failure && !busy && (
              <div className="h-full rounded-xl bg-[#FAF8F4] border border-[#EFEAE2] p-5 text-sm text-[#4A463F] leading-relaxed">
                <p className="font-semibold text-[#141413] mb-2">What happens</p>
                <ol className="list-decimal pl-5 space-y-1">
                  <li>{kind === 'outfit' ? 'Muse Spark reads the photo and your sentence: one box per garment, the piece to keep, the pieces that feel off.' : 'Muse Spark lists each garment it can see on the rail or in the closet, up to 16, one box each.'}</li>
                  <li>SAM 3.1 cuts each garment out with its own mask.</li>
                  <li>Code checks both answers and measures each colour from the mask pixels. It asks you when the two disagree.</li>
                  <li>You confirm; the pieces join your signed-in wardrobe. No price, wear or decision is added for you.</li>
                </ol>
              </div>
            )}
            {failure && (
              <div className="rounded-xl border border-[#E7C9B5] bg-[#FDF5EF] p-4 text-sm" data-testid="scan-failure">
                <p className="font-semibold text-[#141413]">Not scanned · {failure.code}</p>
                <p className="text-[#4A463F] mt-1">{failure.detail}</p>
                <p className="text-[11px] text-[#6B665E] mt-2">Nothing was added to your closet.</p>
              </div>
            )}
            {result && (
              <div className="flex flex-col gap-3" data-testid="scan-result">
                <div className="flex flex-wrap gap-2 text-[11px] font-mono text-[#4A463F]">
                  <span className="px-2 py-0.5 rounded bg-[#F6F3EE]">{result.cards.length} garments</span>
                  {result.kind === 'outfit' ? (
                    <span className="px-2 py-0.5 rounded bg-[#F6F3EE]">direction: {DIRECTION[result.direction] ?? result.direction}</span>
                  ) : (
                    <span className="px-2 py-0.5 rounded bg-[#F6F3EE]">{result.moreNotListed ? 'more in the photo than listed' : 'closet photo'}</span>
                  )}
                  <span className="px-2 py-0.5 rounded bg-[#F6F3EE]">{cutoutSummary(result.cards)}</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {result.cards.map((c) => {
                    const shoes = c.slot === 'shoes';
                    // While Spark and the pixels disagree, the title names no colour until the owner picks one.
                    const color = chosen[c.cardId] ?? (c.colorChoices ? 'unknown' : c.maskColor ?? c.sparkColor);
                    return (
                      <div key={c.cardId} className={`rounded-xl border p-2.5 flex flex-col gap-2 ${keep[c.cardId] ? 'border-[#F37021]' : 'border-[#E7E2DA]'}`} data-testid="scan-card">
                        <div className="aspect-square rounded-lg bg-[repeating-conic-gradient(#F3F0EA_0%_25%,#FFFFFF_0%_50%)] bg-[length:16px_16px] flex items-center justify-center overflow-hidden">
                          <img src={c.cutout} alt={`${label(c.type)} cut out`} className="max-w-full max-h-full object-contain" />
                        </div>
                        <div className="text-sm font-semibold text-[#141413] capitalize">{color === 'unknown' ? '' : `${color} `}{label(c.type)}</div>
                        <div className="text-[11px] text-[#6B665E] leading-snug">
                          Spark: {c.sparkColor}{c.maskColor ? <> · pixels: {c.maskColor}</> : ' · pixels: not measured'}
                        </div>
                        <div className="flex flex-wrap gap-1 text-[10px] font-semibold uppercase tracking-wide">
                          {c.pinned && <span className="px-1.5 py-0.5 rounded bg-[#141413] text-white">keep</span>}
                          {c.offender && <span className="px-1.5 py-0.5 rounded border border-[#B8460F] text-[#B8460F]">{WHY[c.offender] ?? c.offender}</span>}
                        </div>
                        {c.colorChoices && keep[c.cardId] && (
                          <div className="flex flex-col gap-1">
                            <span className="text-[11px] text-[#141413]">Which colour is it?</span>
                            <div className="flex gap-1">
                              {c.colorChoices.map((k) => (
                                <button key={k} type="button" onClick={() => setChosen((s) => ({ ...s, [c.cardId]: k }))} className={`px-2 py-1 text-[11px] rounded border ${chosen[c.cardId] === k ? 'border-[#F37021] bg-[#FDF1E8]' : 'border-[#E7E2DA]'}`}>{k}</button>
                              ))}
                            </div>
                          </div>
                        )}
                        {shoes ? (
                          <span className="text-[10px] text-[#6B665E]">Shoes are not hung on the rail yet.</span>
                        ) : (
                          <label className="flex items-center gap-1.5 text-[11px] text-[#141413] cursor-pointer">
                            <input type="checkbox" checked={!!keep[c.cardId]} onChange={(e) => setKeep((s) => ({ ...s, [c.cardId]: e.target.checked }))} />
                            Hang this piece
                          </label>
                        )}
                      </div>
                    );
                  })}
                </div>
                {result.kind === 'closet' && result.moreNotListed && !partsDone && (
                  <button type="button" onClick={scanRest} disabled={previewOnly || moreBusy || busy || (live && !workspaceId)} data-testid="scan-rest" className="self-start px-3 py-1.5 text-[11px] font-semibold rounded-lg border border-[#F37021] text-[#B8460F] disabled:opacity-40 inline-flex items-center gap-1.5">
                    {moreBusy ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Scanning the parts…</> : 'Find the rest: scan 2 overlapping parts (2 more Spark + SAM scans)'}
                  </button>
                )}
                {result.notes.length > 0 && (
                  <ul className="text-[11px] text-[#6B665E] list-disc pl-4" data-testid="scan-notes">{result.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
                )}
                <div className="text-[10px] font-mono text-[#6B665E]" data-testid="scan-calls">
                  {result.calls.map((c, i) => <span key={i} className="mr-3">{result.mode === 'live' ? 'LIVE' : 'Test fake'} · {c.model} · {c.latencyMs} ms · {c.http}</span>)}
                </div>
              </div>
            )}
          </div>
        </div>

        {result && (
          <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-[#E7E2DA] bg-[#FAF8F4] rounded-b-2xl">
            <span className="text-[11px] text-[#6B665E]">{open.length > 0 ? `Pick a colour on ${open.length} card${open.length > 1 ? 's' : ''} first.` : 'New pieces start with no price, no wear record and no decision.'}</span>
            <button type="button" onClick={hang} disabled={previewOnly || busy || moreBusy || picked.length === 0 || open.length > 0} className="px-4 py-2 text-sm font-semibold rounded-lg bg-[#141413] text-white disabled:opacity-40 inline-flex items-center gap-2" data-testid="scan-hang">
              <Check className="w-4 h-4" />Hang {picked.length} piece{picked.length === 1 ? '' : 's'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
