import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Camera, X } from 'lucide-react';

// First-visit callout over the space: one line and one button, never a modal. Shown only while the
// closet holds no piece from a photo and the viewer has not dismissed it; the dismissal is kept in
// this browser only (spec §3, empty/first-visit state).

const KEY = 'closer.callout.firstPhoto.v1';

export function calloutDismissed(): boolean {
  try {
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

interface SpaceCalloutProps {
  /** Pieces that came from a photo scan; the callout hides once there is one. */
  scannedCount: number;
  onStart: () => void;
}

export const SpaceCallout: React.FC<SpaceCalloutProps> = ({ scannedCount, onStart }) => {
  const [dismissed, setDismissed] = useState<boolean>(() => (typeof window === 'undefined' ? true : calloutDismissed()));
  useEffect(() => {
    if (scannedCount > 0) setDismissed(true);
  }, [scannedCount]);
  // Narrow screens: sit just under the plaque (measured, so a plaque of any height is never covered);
  // wide screens: the top centre of the space, under the title line.
  const ref = useRef<HTMLDivElement | null>(null);
  const [top, setTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const el = ref.current;
      if (!el) return;
      if (window.innerWidth >= 640) {
        setTop(null);
        return;
      }
      const plaque = document.querySelector('[data-testid=asset-ledger-plaque]');
      const parent = el.offsetParent as HTMLElement | null;
      if (!plaque || !parent) return;
      setTop(Math.round(plaque.getBoundingClientRect().bottom - parent.getBoundingClientRect().top + 8));
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, []);
  if (dismissed || scannedCount > 0) return null;
  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(KEY, '1');
    } catch {
      // Storage blocked: the callout stays dismissed for this visit only.
    }
  };
  return (
    <div
      ref={ref}
      className="absolute left-1/2 -translate-x-1/2 top-36 z-20 w-[min(92vw,420px)] bg-white/95 border border-[#E7E2DA] rounded-xl shadow-sm px-4 py-3 flex items-center gap-3"
      style={top === null ? undefined : { top }}
      role="note"
      data-testid="space-callout"
    >
      <Camera className="w-4 h-4 text-[#F37021] shrink-0" aria-hidden="true" />
      <div className="text-xs text-[#141413] leading-snug">
        <span className="font-semibold">Start with one photo.</span>
        <span className="hidden sm:inline"> Each garment becomes a card; confirmed pieces hang here.</span>
      </div>
      <button
        type="button"
        onClick={onStart}
        className="shrink-0 px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#F37021] text-white hover:bg-[#D95D12]"
        data-testid="space-callout-start"
      >
        Add from a photo
      </button>
      <button type="button" onClick={dismiss} aria-label="Not now" className="shrink-0 p-1 rounded-md text-[#8C857B] hover:text-[#141413] hover:bg-[#FAF8F5]" data-testid="space-callout-dismiss">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};
