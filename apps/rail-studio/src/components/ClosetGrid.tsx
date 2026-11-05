import React, { useEffect, useRef } from 'react';
import { GarmentPiece } from '../types/closet';
import { tagForm } from '../utils/tagForms';

// A flat view of the whole closet: one card per piece, the same facts as the rail's tags. Built for
// many pieces (a closet scan can add 16 at once) and for phones, where the rail shows two or three.
// Nothing here is computed beyond what the rail shows: latest price seen (with its platform and
// currency, Sample marked), counted wears in the last 60 days or "no wear log", the saved decision.
// The status forms (dashed "No price seen", a hollow dot for no wear log, "0 wears · 60d") come
// from tagForm, shared with the rail's hang tags.

interface ClosetGridProps {
  garments: GarmentPiece[];
  selectedId: string | null;
  /** A card picks its piece; null (Esc) closes the inspector, as on the rail. */
  onSelect: (id: string | null) => void;
}

// The cards start below the price plaque (the scroller's top padding, with room on phones for the
// one-line 3D-fallback note under the plaque) and the last row clears the control dock (pb-56); a
// selected card is brought into the band between the two.
const TOP_CLEARANCE_FALLBACK_PX = 208;
const BOTTOM_CLEARANCE_PX = 200;

function sourceLine(g: GarmentPiece): string | null {
  if (!g.cutoutSource) return null;
  const how = g.cutoutSource === 'sam-mask' ? 'SAM mask' : 'Spark box';
  return `From a photo · ${how} · ${g.scanMode === 'live' ? 'LIVE' : 'Test fake'}`;
}

export const ClosetGrid: React.FC<ClosetGridProps> = ({ garments, selectedId, onSelect }) => {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const firstPositionRef = useRef(true);
  const lastSelectedRef = useRef<string | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // Esc closes the inspector (one layer at a time), the same rule the rail follows; the grid keeps
  // its scroll. Typing in a field is left alone.
  useEffect(() => {
    if (!selectedId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key === 'Escape') onSelectRef.current(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedId]);

  // Bring the selected card into view when the grid opens with a selection (a deep link, or the
  // selection kept from the rail) and whenever the selection changes. When the inspector closes
  // the cards reflow to full width, so the piece that was open is kept in view rather than a raw
  // scroll position. A card already inside the visible band stays where it is; the first
  // positioning is instant, later ones glide unless the viewer asked for reduced motion.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const targetId = selectedId ?? lastSelectedRef.current;
    lastSelectedRef.current = selectedId;
    if (!targetId) return;
    const card = Array.from(scroller.querySelectorAll<HTMLElement>('[data-piece-id]')).find(
      (el) => el.dataset.pieceId === targetId,
    );
    if (!card) return;
    const reduced =
      typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const instant = firstPositionRef.current || reduced;
    firstPositionRef.current = false;

    const topClearance =
      parseFloat(window.getComputedStyle(scroller).paddingTop) || TOP_CLEARANCE_FALLBACK_PX;
    const box = scroller.getBoundingClientRect();
    const rect = card.getBoundingClientRect();
    const cardTop = rect.top - box.top + scroller.scrollTop;
    const cardBottom = cardTop + rect.height;
    const bandTop = scroller.scrollTop + topClearance;
    const bandBottom = scroller.scrollTop + box.height - BOTTOM_CLEARANCE_PX;
    if (cardTop >= bandTop && cardBottom <= bandBottom) return;

    const bandHeight = box.height - topClearance - BOTTOM_CLEARANCE_PX;
    const top =
      rect.height >= bandHeight || cardTop < bandTop
        ? cardTop - topClearance
        : cardBottom - (box.height - BOTTOM_CLEARANCE_PX);
    scroller.scrollTo({ top: Math.max(0, top), behavior: instant ? 'auto' : 'smooth' });
  }, [selectedId]);

  if (garments.length === 0) {
    return (
      <div className="absolute inset-0 flex items-center justify-center text-sm text-[#57534E]" data-testid="closet-grid-empty">
        No pieces in this filter.
      </div>
    );
  }
  // Beside the open inspector (a 520px right drawer from 1024px up) the cards reflow into the space
  // left of it, so the selected card is never under the drawer.
  const drawerOpen = selectedId !== null;
  return (
    <div
      ref={scrollerRef}
      className={`absolute inset-0 overflow-y-auto px-4 sm:px-6 pt-60 sm:pt-52 pb-56 ${drawerOpen ? 'lg:pr-[536px]' : ''}`}
      data-testid="closet-grid"
      data-drawer={drawerOpen ? 'open' : 'closed'}
    >
      <div className={`grid grid-cols-2 sm:grid-cols-3 gap-3 max-w-6xl mx-auto ${drawerOpen ? 'lg:grid-cols-3 xl:grid-cols-4' : 'lg:grid-cols-5'}`}>
        {garments.map((g) => {
          const form = tagForm(g);
          const img = g.frontImageUrl || g.imageUrl;
          const decision = g.lastDecision?.choice;
          const src = sourceLine(g);
          const selected = selectedId === g.id;
          return (
            <button
              key={g.id}
              type="button"
              onClick={() => onSelect(g.id)}
              aria-pressed={selected}
              data-testid="closet-grid-card"
              data-piece-id={g.id}
              data-piece-code={g.code}
              data-tag-kind={form.kind}
              data-wear-log={form.hollow ? 'none' : 'verified'}
              className={`text-left rounded-xl border bg-white p-2.5 flex flex-col gap-2 transition-colors hover:border-[#F37021] ${selected ? 'border-[#F37021] ring-1 ring-[#F37021]' : 'border-[#E7E2DA]'}`}
            >
              <div className="aspect-[3/4] rounded-lg bg-[#FAF8F5] flex items-center justify-center overflow-hidden">
                {img ? (
                  <img src={img} alt={g.name || g.code} loading="lazy" className="max-w-full max-h-full object-contain" />
                ) : (
                  <span className="w-10 h-10 rounded-full" style={{ background: g.colorHex }} aria-hidden="true" />
                )}
              </div>
              <div className="flex items-center justify-between gap-1">
                <span className="font-mono-num text-[11px] font-semibold text-[#141413]">{g.code}</span>
                {g.isSample ? (
                  <span className="text-[10px] px-1.5 py-0.5 rounded border border-dashed border-[#B8B2A7] text-[#57534E]">Sample</span>
                ) : decision ? (
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${decision === 'keep' ? 'bg-[#141413] text-white' : 'border border-[#B8460F] text-[#B8460F]'}`}>{decision === 'keep' ? 'Keep' : 'Sell'}</span>
                ) : (
                  <span className="text-[10px] text-[#8C857B]">Undecided</span>
                )}
              </div>
              <div className="text-xs text-[#141413] leading-snug line-clamp-2 min-h-[2rem]">
                {g.brand ? <span className="font-semibold">{g.brand} </span> : null}
                {g.name || 'Name not entered'}
              </div>
              <div className="text-[11px] text-[#141413]" data-testid="closet-grid-price">
                {form.kind === 'price' ? (
                  <span className="font-mono-num">
                    {form.priceText}
                    <span className="text-[#8C857B]"> · {form.platform}{form.ask ? ' ask' : ''}{form.samplePrice ? ' · Sample' : ''}</span>
                  </span>
                ) : (
                  <span className="inline-block px-1.5 py-0.5 rounded border border-dashed border-[#B8B2A7] text-[#57534E] font-medium">
                    {form.priceText}
                  </span>
                )}
              </div>
              <div className="text-[10px] text-[#57534E] flex items-center gap-1.5" data-testid="closet-grid-wear">
                <span
                  aria-hidden="true"
                  data-wear-dot={form.hollow ? 'hollow' : 'solid'}
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${form.hollow ? 'border border-[#A8A29E] bg-transparent' : 'bg-[#57534E]'}`}
                />
                <span>{form.wearText}</span>
              </div>
              {src && <div className="text-[10px] text-[#B8460F]">{src}</div>}
            </button>
          );
        })}
      </div>
    </div>
  );
};
