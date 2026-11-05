import React, { useState } from 'react';
import { ArrowUpRight, ChevronRight } from 'lucide-react';
import type { GarmentPiece } from '../types/closet';
import { formatCurrency, getLatestObservation } from '../utils/ledgerLogic';
import { isPersonalPiece } from '../utils/accountWardrobe';

/** A window onto entered prices; this card never fetches or invents a market quote. */
export function MarketPulse({ garments, onSelect, demo = false }: {
  garments: GarmentPiece[];
  onSelect: (id: string) => void;
  demo?: boolean;
}) {
  const [index, setIndex] = useState(0);
  const records = garments.flatMap(piece => {
    const latest = getLatestObservation(piece);
    return latest ? [{ piece, latest }] : [];
  }).sort((a, b) => b.latest.date.localeCompare(a.latest.date));
  if (!records.length) return null;
  const { piece, latest } = records[index % records.length];
  const sameSeries = piece.observations.filter(row => row.currency === latest.currency &&
    row.platform === latest.platform && row.kind === latest.kind &&
    Boolean(row.isSample) === Boolean(latest.isSample))
    .sort((a, b) => a.date.localeCompare(b.date));
  const first = sameSeries[0];
  const difference = sameSeries.length > 1 ? latest.price - first.price : null;
  const sample = demo || !isPersonalPiece(piece) || latest.isSample;
  return (
    <aside aria-label="Market Pulse" className="hidden lg:block absolute top-24 right-6 z-10 w-[274px] rounded-2xl border border-[#E7E2DA] bg-white/95 p-4 shadow-sm backdrop-blur-sm">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[11px] font-semibold tracking-widest uppercase text-[#57534E]">Market Pulse</h2>
        {records.length > 1 && <button type="button" aria-label="Next price record" onClick={() => setIndex(value => (value + 1) % records.length)} className="min-h-9 inline-flex items-center gap-1 text-xs text-[#57534E] hover:text-[#B8460F]">
          {(index % records.length) + 1}/{records.length}<ChevronRight size={13} />
        </button>}
      </div>
      <p className="mt-1 text-[10px] text-[#8C857B]">{sample ? 'Sample prices' : 'Prices you entered'} · no automatic price feed</p>
      <p className="mt-3 text-xs font-medium text-[#57534E] truncate">{piece.code} · {piece.brand || 'Your piece'}</p>
      <p className="mt-0.5 text-sm font-semibold leading-snug line-clamp-2">{piece.name}</p>
      <p className="mt-2 font-mono-num text-[27px] leading-tight font-semibold text-[#141413]">{formatCurrency(latest.price, latest.currency)}</p>
      <p className="mt-1 text-xs text-[#57534E]">{latest.platform} · {latest.kind === 'traded' ? 'Trade recorded' : 'Asking price'} · {latest.date}</p>
      {difference !== null && <p className="mt-2 text-xs font-mono-num text-[#B8460F]">{difference >= 0 ? '+' : '−'}{formatCurrency(Math.abs(difference), latest.currency)} <span className="font-sans text-[#8C857B]">since {first.date} · same platform</span></p>}
      <button type="button" onClick={() => onSelect(piece.id)} className="mt-3 min-h-10 w-full flex justify-between items-center border-t border-[#E7E2DA] pt-2 text-xs font-semibold text-[#B8460F]">Inspect piece &amp; prices<ArrowUpRight size={15} /></button>
    </aside>
  );
}
