import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import {
  ArrowUpRight,
  Calendar,
  Camera,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  Info,
  Lock,
  Plus,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { GarmentPiece, ResalePlatform, TargetLook } from '../types/closet';
import {
  INITIAL_GARMENTS,
  platformsForCurrency,
  TARGET_LOOKS,
} from '../data/seedCloset';
import {
  defaultAskPrice,
  describePhotoSource,
  formatCurrency,
  formatShortDate,
  getLatestObservation,
  hasFactsMoved,
  isKeptAfterReload,
  plural,
  PriceRecordCount,
  REFERENCE_DATE,
  resolve3DDisplayVariant,
  sortObservationsChronologically,
  summarizeKeepSellEvidence,
} from '../utils/ledgerLogic';
import { KalshiPriceChart } from './KalshiPriceChart';
import {
  decisionStorageNote,
  hasTwoPhotos,
  InspectorChipTone,
  latestPricePerPlatform,
  netIfSold,
  purchaseLines,
  resolveSheetDrag,
  SHEET_HALF_RATIO,
  SheetState,
  sheetHeightWhileDragging,
  statusChips,
  wearRecordParts,
} from './InspectorLogic';

const SEED_IDS = new Set(INITIAL_GARMENTS.map((g) => g.id));

/** Below Tailwind's `lg` (64rem) the inspector is a bottom sheet; from `lg` up it is the right drawer. */
const PHONE_LAYOUT_QUERY = '(max-width: 1023.98px)';

function useIsPhoneLayout(): boolean {
  const [isPhone, setIsPhone] = useState<boolean>(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(PHONE_LAYOUT_QUERY).matches
      : false,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(PHONE_LAYOUT_QUERY);
    const onChange = () => setIsPhone(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return isPhone;
}

/** "2 trades (Aug 05 – Nov 04)" style text for a counted set of price records. */
function describeRecordCount(
  singular: string,
  rc: PriceRecordCount,
): string {
  if (rc.count === 0) return `0 ${singular}s`;
  const range =
    rc.firstDate && rc.lastDate && rc.firstDate !== rc.lastDate
      ? `${formatShortDate(rc.firstDate)} – ${formatShortDate(rc.lastDate)}`
      : formatShortDate(rc.lastDate);
  return `${plural(rc.count, singular)} (${range})`;
}

const CHIP_CLASS: Record<InspectorChipTone, string> = {
  sample: 'border border-dashed border-[#F37021] text-[#F37021] bg-white',
  source: 'border border-[#F37021]/30 text-[#B8460F] bg-[#FFF3EB]',
  keep: 'border border-[#141413] bg-[#141413] text-white',
  sell: 'border border-[#B8460F] text-[#B8460F] bg-white',
  undecided: 'border border-[#E7E2DA] text-[#8C857B] bg-white',
};

type InspectorTab = 'market' | 'wear' | 'decide';

interface GarmentInspectDrawerProps {
  garment: GarmentPiece | null;
  /** Supplied by the account save controller, only after server read-back. */
  persistenceNotice?: string;
  looks?: TargetLook[];
  onClose: () => void;
  onSaveDecision: (
    garmentId: string,
    choice: 'keep' | 'sell',
    customAskPrice?: number,
  ) => void;
  onAddObservation: (
    garmentId: string,
    platform: ResalePlatform,
    price: number,
    kind: 'traded' | 'listed',
  ) => void;
  onUpdateFeeConfig: (
    garmentId: string,
    feeRateConfirmed: boolean,
    shippingConfirmed: boolean,
  ) => void;
  onToggleTodayLock: (garmentId: string) => void;
  onLockLookForToday?: (pieceCodes: string[]) => void;
  onOpenSnapUpload?: () => void;
  onUpdateGarmentPhoto?: (garmentId: string, dataUrl: string) => void;
  /** Removes a piece added from a photo scan (sample pieces cannot be removed). */
  onRemovePiece?: (garmentId: string) => void;
}

export const GarmentInspectDrawer: React.FC<GarmentInspectDrawerProps> = ({
  garment,
  persistenceNotice,
  looks = TARGET_LOOKS,
  onClose,
  onSaveDecision,
  onAddObservation,
  onUpdateFeeConfig,
  onToggleTodayLock,
  onLockLookForToday,
  onOpenSnapUpload,
  onUpdateGarmentPhoto,
  onRemovePiece,
}) => {
  const [activeTab, setActiveTab] = useState<InspectorTab>('market');
  const [chartWindow, setChartWindow] = useState<'30d' | '90d' | 'all'>('all');
  const [showAddQuote, setShowAddQuote] = useState(false);
  const [quotePlatform, setQuotePlatform] = useState<ResalePlatform>('KREAM');
  const [quotePrice, setQuotePrice] = useState('');
  const [quoteKind, setQuoteKind] = useState<'traded' | 'listed'>('listed');
  const [quoteError, setQuoteError] = useState('');
  const [imgFailed, setImgFailed] = useState(false);
  const [photoAngle, setPhotoAngle] = useState<'front' | 'side'>('front');
  const [showEvidence, setShowEvidence] = useState<boolean>(false);
  const [excludedObsIds, setExcludedObsIds] = useState<string[]>([]);
  const [draftCopied, setDraftCopied] = useState<'idle' | 'copied' | 'failed'>(
    'idle',
  );

  // Expandable "what was counted" notes next to 'Counted wears' and 'Counted prices'
  const [showKeepProvenance, setShowKeepProvenance] = useState<boolean>(false);
  const [showSellProvenance, setShowSellProvenance] = useState<boolean>(false);

  // Phone bottom sheet: about 70% tall, dragged up to full height or down to close.
  const isPhone = useIsPhoneLayout();
  const [sheetState, setSheetState] = useState<SheetState>('half');
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    from: SheetState;
    viewportHeight: number;
    moved: boolean;
  } | null>(null);

  const d3SvgRef = useRef<SVGSVGElement | null>(null);
  const isDraggingHandleRef = useRef<boolean>(false);
  const inlinePhotoInputRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<HTMLDivElement | null>(null);
  const askSimulatorRef = useRef<HTMLDivElement | null>(null);
  const quoteFormRef = useRef<HTMLFormElement | null>(null);

  const effectiveGarment = useMemo(() => {
    if (!garment) return null;
    if (excludedObsIds.length === 0) return garment;
    const filteredObs = garment.observations.filter(
      (o) => !excludedObsIds.includes(o.id),
    );
    return {
      ...garment,
      observations:
        filteredObs.length > 0 ? filteredObs : garment.observations,
    };
  }, [garment, excludedObsIds]);

  // The ask starts from the latest price seen, else the purchase price. A piece with neither
  // (e.g. just scanned from a photo) gets NO default ask: it shows "not set".
  const startAskPrice = useMemo(
    () => (effectiveGarment ? defaultAskPrice(effectiveGarment) : null),
    [effectiveGarment],
  );

  const [simulatedAskPrice, setSimulatedAskPrice] = useState<number | null>(
    startAskPrice,
  );

  // Reset per-garment interactive states when switching garments.
  useEffect(() => {
    setActiveTab('market');
    setSimulatedAskPrice(startAskPrice);
    setImgFailed(false);
    setPhotoAngle(
      garment?.occlusionStatus === 'side_occluded' ? 'side' : 'front',
    );
    setExcludedObsIds([]);
    setDraftCopied('idle');
    setQuotePlatform(
      garment
        ? (platformsForCurrency(garment.currency).find(
            (p) => p.name === garment.feeConfig.platform,
          )?.name ??
            platformsForCurrency(garment.currency)[0]?.name ??
            'KREAM')
        : 'KREAM',
    );
    setQuoteError('');
    setShowAddQuote(false);
    setShowKeepProvenance(false);
    setShowSellProvenance(false);
    setShowEvidence(false);
    bodyRef.current?.scrollTo({ top: 0 });
  }, [garment?.id]);

  // Keep the ask synced if the starting price changes (a price was added or excluded)
  useEffect(() => {
    setSimulatedAskPrice(startAskPrice);
  }, [startAskPrice]);

  // When the panel closes, the next open starts as a half sheet on Market tab.
  const isOpen = garment !== null;
  useEffect(() => {
    if (isOpen) return;
    setSheetState('half');
    setDragHeight(null);
    dragRef.current = null;
    setActiveTab('market');
  }, [isOpen]);

  // Behind an open phone sheet nothing scrolls: the page is locked while it is up.
  useEffect(() => {
    if (!isOpen || !isPhone || typeof document === 'undefined') return;
    const root = document.documentElement;
    root.classList.add('inspector-sheet-open');
    return () => root.classList.remove('inspector-sheet-open');
  }, [isOpen, isPhone]);

  if (!garment || !effectiveGarment) return null;

  const displayVariant = resolve3DDisplayVariant(garment);
  const latestObs = getLatestObservation(effectiveGarment);

  const hasPriceBasis = startAskPrice !== null;
  const askPrice = hasPriceBasis ? simulatedAskPrice : null;

  const twoPhotos = hasTwoPhotos(garment);
  const activePhotoUrl =
    photoAngle === 'front' || !twoPhotos
      ? garment.frontImageUrl || garment.imageUrl
      : garment.imageUrl || garment.frontImageUrl;

  const factsMoved = hasFactsMoved(garment);
  const displayDate = /^(scan-|piece-custom-)/.test(garment.id) && !garment.isSample
    ? new Date().toLocaleDateString('en-CA') : REFERENCE_DATE;

  const evidence = summarizeKeepSellEvidence(
    effectiveGarment,
    askPrice,
    looks,
    displayDate,
  );
  const { keepScenario, sellScenario, summary } = evidence;

  // Anchor for the slider range and presets: the latest price seen, else the purchase price.
  const anchorPrice = startAskPrice ?? 1;
  const anchorIsLatest = sellScenario.latestPrice !== null;

  const sliderStep = garment.currency === 'KRW' ? 5000 : 5;
  const sliderMin = Math.max(
    1,
    Math.round((anchorPrice * 0.75) / sliderStep) * sliderStep,
  );
  const sliderMax = Math.max(
    sliderMin + (garment.currency === 'KRW' ? 50000 : 50),
    Math.round((anchorPrice * 1.22) / sliderStep) * sliderStep,
  );

  const quotePlatformOptions = platformsForCurrency(garment.currency);

  // D3 recorded-price dots & Draggable Ask-Price Handle geometry
  const d3Width = 220;
  const d3Height = 96;
  const d3PadX = 12;
  const d3PadY = 14;

  const sortedComps = sortObservationsChronologically(
    effectiveGarment.observations.filter(
      (o) => o.currency === garment.currency && o.price > 0,
    ),
  );

  const compPrices = sortedComps.map((o) => o.price);
  const yDomainMin = Math.min(sliderMin, ...(compPrices.length > 0 ? compPrices : [sliderMin]));
  const yDomainMax = Math.max(sliderMax, ...(compPrices.length > 0 ? compPrices : [sliderMax]));

  const d3XScale = d3
    .scaleLinear()
    .domain([0, Math.max(1, sortedComps.length - 1)])
    .range([d3PadX, d3Width - 70]);

  const d3YScale = d3
    .scaleLinear()
    .domain([yDomainMin * 0.96, yDomainMax * 1.04])
    .range([d3Height - d3PadY, d3PadY])
    .clamp(true);

  const compSeries = sortedComps.map((o, idx) => ({
    idx,
    price: o.price,
    obs: o,
  }));
  const askHandleY = d3YScale(askPrice ?? anchorPrice);

  const updateAskFromSvgClientY = (clientY: number) => {
    const svgEl = d3SvgRef.current;
    if (!svgEl) return;
    const rect = svgEl.getBoundingClientRect();
    const relY = ((clientY - rect.top) / Math.max(1, rect.height)) * d3Height;
    const invertedPrice = d3YScale.invert(relY);
    const snapped = Math.round(invertedPrice / sliderStep) * sliderStep;
    const clamped = Math.max(sliderMin, Math.min(sliderMax, snapped));
    setSimulatedAskPrice(clamped);
  };

  const handleToggleExcludeObs = (obsId: string) => {
    setExcludedObsIds((prev) =>
      prev.includes(obsId)
        ? prev.filter((id) => id !== obsId)
        : [...prev, obsId],
    );
  };

  const handleInlinePhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !onUpdateGarmentPhoto) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setImgFailed(false);
        onUpdateGarmentPhoto(garment.id, reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleQuoteSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const numeric = Number(quotePrice.replace(/,/g, '').trim());
    if (!Number.isFinite(numeric) || numeric <= 0) {
      setQuoteError('Enter a valid positive price you saw.');
      return;
    }
    if (!quotePlatformOptions.some((p) => p.name === quotePlatform)) {
      setQuoteError(`${quotePlatform} does not quote in ${garment.currency}.`);
      return;
    }
    setQuoteError('');
    onAddObservation(garment.id, quotePlatform, numeric, quoteKind);
    setSimulatedAskPrice(numeric);
    setQuotePrice('');
    setShowAddQuote(false);
  };

  const toggleAddQuote = () => {
    if (activeTab === 'market' && showAddQuote) {
      setShowAddQuote(false);
      return;
    }
    setActiveTab('market');
    setShowAddQuote(true);
    setTimeout(() => {
      bodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    }, 20);
  };

  const jumpToChart = () => {
    setActiveTab('market');
    setTimeout(() => {
      chartRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, 20);
  };

  const jumpToAskTools = () => {
    setActiveTab('decide');
    setTimeout(() => {
      askSimulatorRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, 20);
  };

  // --- Phone sheet drag (pointer events on the handle) ---
  const onHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isPhone) return;
    dragRef.current = {
      pointerId: e.pointerId,
      startY: e.clientY,
      from: sheetState,
      viewportHeight: window.innerHeight,
      moved: false,
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };
  const onHandlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dy = e.clientY - d.startY;
    if (Math.abs(dy) > 3) d.moved = true;
    setDragHeight(sheetHeightWhileDragging(d.from, dy, d.viewportHeight));
  };
  const onHandlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    setDragHeight(null);
    if (!d.moved) {
      setSheetState((s) => (s === 'half' ? 'full' : 'half'));
      return;
    }
    const next = resolveSheetDrag(d.from, e.clientY - d.startY, d.viewportHeight);
    if (next === 'closed') onClose();
    else setSheetState(next);
  };
  const onHandlePointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setDragHeight(null);
  };

  const photoSource = describePhotoSource(garment);
  const isSeed = SEED_IDS.has(garment.id);
  const priceRecordCount =
    sellScenario.traded.count + sellScenario.listed.count;
  const priceStep = isSeed
    ? '② Sample price records · no Spark call'
    : priceRecordCount > 0
      ? `② ${plural(priceRecordCount, 'price')} you entered`
      : garment.purchasePrice
        ? '② Purchase price only'
        : '② No price on record';
  const keptAfterReload = isKeptAfterReload(garment) || garment.id.startsWith('piece-custom-');
  const storageNote = persistenceNotice ?? decisionStorageNote(garment);
  const wearDaysText =
    keepScenario.daysSinceLastWorn !== null
      ? `${keepScenario.daysSinceLastWorn} days ago`
      : 'date unknown';

  const chips = statusChips(garment);
  const purchase = purchaseLines(garment);
  const wear = wearRecordParts(keepScenario);
  const priceSeen = latestPricePerPlatform(
    effectiveGarment.observations,
    garment.currency,
    3,
  );
  const net = netIfSold(askPrice, sellScenario.netPayoutInfo);

  const listingDraftText = `[${garment.brand || '[VERIFY: Brand]'}] ${garment.name} (${garment.code})
· Target Ask Price: ${askPrice !== null ? `${formatCurrency(askPrice, garment.currency)} (${sellScenario.platform})` : '[VERIFY: Asking Price]'}
· Fabric / Condition: ${garment.fabricLabel} / ${garment.conditionGrade ?? '[VERIFY: Condition Grade]'}
· Size / Measurements: [VERIFY: Tag Size & Measurements]
· Provenance / Packaging: [VERIFY: Original Receipt / Tags]`;

  const handleCopyListingDraft = async () => {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(listingDraftText);
      setDraftCopied('copied');
    } catch {
      setDraftCopied('failed');
    }
    setTimeout(() => setDraftCopied('idle'), 2200);
  };

  const askPresets = [
    {
      label: anchorIsLatest ? '−10% of latest' : '−10% of paid',
      price: Math.round((anchorPrice * 0.9) / sliderStep) * sliderStep,
    },
    {
      label: anchorIsLatest ? 'Latest Price Seen' : 'Purchase Price',
      price: anchorPrice,
    },
    {
      label: anchorIsLatest ? '+10% of latest' : '+10% of paid',
      price: Math.round((anchorPrice * 1.1) / sliderStep) * sliderStep,
    },
  ];

  const photoLabel =
    garment.occlusionStatus === 'side_occluded'
      ? 'Side / Occluded Photo (your choice)'
      : photoAngle === 'front' || !twoPhotos
        ? garment.cutoutSource
          ? garment.scanMode === 'live'
            ? garment.cutoutSource === 'sam-mask'
              ? 'Front Shot · SAM 3.1 Cut-Out'
              : 'Front Shot · Spark Box Crop'
            : 'Front Shot · Test-Fake Cut-Out'
          : 'Front Shot · Photo'
        : 'Side Profile · Rail View';

  const sheetStyle: React.CSSProperties | undefined = isPhone
    ? {
        height:
          dragHeight !== null
            ? `${dragHeight}px`
            : sheetState === 'full'
              ? '100%'
              : `${Math.round(SHEET_HALF_RATIO * 100)}%`,
      }
    : undefined;

  const sheetStateAttr = isPhone ? sheetState : 'drawer';

  return (
    <>
      {isPhone && (
        <div
          className="inspector-backdrop fixed inset-0 z-30 bg-[#141413]/25 lg:hidden"
          onClick={onClose}
          aria-hidden="true"
          data-testid="inspector-backdrop"
        />
      )}

      <aside
        aria-label={`Inspect ${garment.name}`}
        role={isPhone ? 'dialog' : undefined}
        aria-modal={isPhone ? true : undefined}
        data-testid="inspector-sheet"
        data-sheet-state={sheetStateAttr}
        data-dragging={dragHeight !== null ? 'true' : undefined}
        style={sheetStyle}
        className={`inspector-sheet fixed z-30 bg-white shadow-2xl flex flex-col overflow-hidden inset-x-0 bottom-0 max-h-full border-t border-[#E7E2DA] ${
          isPhone && sheetState === 'full' && dragHeight === null ? 'rounded-none' : 'rounded-t-2xl'
        } lg:inset-x-auto lg:top-[61px] lg:right-0 lg:bottom-0 lg:w-full lg:max-w-[520px] lg:rounded-none lg:border-t-0 lg:border-l lg:max-h-none`}
      >
        <div
          className="flex flex-col h-full min-h-0"
          data-testid="garment-inspect-drawer"
        >
          {/* Phone only: drag handle */}
          <div
            className="inspector-sheet-handle lg:hidden shrink-0 flex items-center justify-center pt-2 pb-1 cursor-grab active:cursor-grabbing select-none"
            data-testid="inspector-sheet-handle"
            role="button"
            tabIndex={0}
            aria-label={
              sheetState === 'full'
                ? 'Drag down to shrink or close this panel'
                : 'Drag up for full height, down to close'
            }
            onPointerDown={onHandlePointerDown}
            onPointerMove={onHandlePointerMove}
            onPointerUp={onHandlePointerUp}
            onPointerCancel={onHandlePointerCancel}
            onKeyDown={(e) => {
              if (e.key === 'ArrowUp') setSheetState('full');
              else if (e.key === 'ArrowDown') {
                if (sheetState === 'full') setSheetState('half');
                else onClose();
              } else if (e.key === 'Escape') onClose();
            }}
          >
            <span className="w-10 h-1 rounded-full bg-[#D9D3C9]" aria-hidden="true" />
          </div>

          {/* Top bar: code · brand · fixture badge · condition, with panel controls */}
          <div className="flex items-center justify-between gap-2 px-5 py-2.5 lg:py-3 border-b border-[#E7E2DA] bg-white shrink-0">
            <div className="flex items-center gap-2 text-xs text-[#8C857B] min-w-0">
              <span className="font-mono-num font-bold text-[#141413]">
                {garment.code}
              </span>
              <span aria-hidden="true">·</span>
              <span className="truncate font-medium text-[#57534E]">
                {garment.brand || 'Brand not entered'}
              </span>
              <span
                data-testid="inspector-fixture-badge"
                title={displayVariant.fixtureTitle}
                className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border whitespace-nowrap shrink-0 ${
                  displayVariant.variant === 'glossy-glass-box'
                    ? 'bg-[#EEF6FA] border-[#9CC5DC] text-[#1D5B79]'
                    : displayVariant.variant === 'trouser-clamp'
                      ? 'bg-[#F8F3EB] border-[#C5A572] text-[#7A5A2B]'
                      : 'bg-[#FAF8F5] border-[#E7E2DA] text-[#57534E]'
                }`}
              >
                {displayVariant.shortBadge}
              </span>
              {garment.conditionGrade && (
                <>
                  <span aria-hidden="true" className="hidden sm:inline">·</span>
                  <span className="hidden sm:inline text-[#141413] font-medium whitespace-nowrap">
                    {garment.conditionGrade}
                  </span>
                </>
              )}
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              {onRemovePiece && keptAfterReload && (
                <button
                  type="button"
                  onClick={() => onRemovePiece(garment.id)}
                  data-testid="remove-scanned-piece"
                  className="px-2.5 py-1.5 rounded-lg bg-white hover:bg-[#FDF5EF] border border-[#E7E2DA] text-[11px] font-medium text-[#57534E] transition-colors"
                  title="Take this scanned piece off the rail (this browser only)"
                >
                  Remove
                </button>
              )}
              {onOpenSnapUpload && (
                <button
                  type="button"
                  onClick={onOpenSnapUpload}
                  className="px-2.5 py-1.5 rounded-lg bg-[#FAF8F5] hover:bg-[#FFF3EB] border border-[#E7E2DA] text-[11px] font-medium text-[#141413] inline-flex items-center gap-1 transition-colors whitespace-nowrap"
                  title="Upload a new garment photo to the 3D rail"
                >
                  <Camera className="w-3.5 h-3.5 text-[#F37021]" />
                  <span>+ Snap Photo</span>
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                aria-label="Close inspection panel"
                className="p-2 rounded-lg text-[#57534E] hover:text-[#141413] hover:bg-[#FAF8F5] transition-colors shrink-0"
                title="Close (Return to Full 3D Rail)"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Sticky Identity + Hero Market Strip + 3-Tab Segmented IA Bar */}
          <div className="px-5 pt-3 pb-2.5 border-b border-[#E7E2DA] bg-[#FAF8F5] shrink-0 space-y-2.5">
            {/* Compact Identity Row */}
            <div className="flex items-start justify-between gap-2" data-testid="inspector-identity">
              <h2 className="text-sm lg:text-[15px] font-semibold text-[#141413] leading-snug min-w-0 truncate">
                {garment.name || 'Name not entered'}
              </h2>
              <div
                className="flex flex-wrap items-center justify-end gap-1 shrink-0"
                data-testid="inspector-status-chips"
              >
                {chips.map((chip) => (
                  <span
                    key={chip.id}
                    data-testid={`inspector-chip-${chip.id}`}
                    title={chip.title}
                    className={`text-[10px] font-semibold px-2 py-0.5 rounded whitespace-nowrap ${CHIP_CLASS[chip.tone]}`}
                  >
                    {chip.label}
                  </span>
                ))}
              </div>
            </div>

            {/* Hero Market Summary Strip (Always visible above tabs) */}
            <div
              className="flex items-center gap-3 bg-white border border-[#E7E2DA] rounded-xl px-3 py-2.5 shadow-2xs"
              data-testid="inspector-hero-market-strip"
            >
              <button
                type="button"
                onClick={() => setActiveTab('wear')}
                title="Inspect garment photo & wear log"
                className="w-12 h-14 rounded-lg bg-[#FAF8F5] border border-[#E7E2DA] hover:border-[#F37021] overflow-hidden flex items-center justify-center shrink-0 transition-colors"
              >
                {activePhotoUrl && !imgFailed ? (
                  <img
                    src={activePhotoUrl}
                    alt={`${garment.brand} ${garment.name}`}
                    referrerPolicy="no-referrer"
                    onError={() => setImgFailed(true)}
                    className="w-full h-full object-contain p-1"
                  />
                ) : (
                  <span
                    className="w-6 h-6 rounded-full border border-black/10"
                    style={{ backgroundColor: garment.colorHex }}
                  />
                )}
              </button>

              <div className="min-w-0 flex-1">
                <div className="text-[10px] font-semibold tracking-wider uppercase text-[#8C857B] flex items-center gap-1.5 flex-wrap">
                  <span>Latest Price Seen</span>
                  {latestObs && (
                    <span className="font-mono-num text-[#57534E] normal-case">
                      · {latestObs.platform} ({latestObs.kind === 'traded' ? '● Trade' : '○ Ask'})
                    </span>
                  )}
                  {latestObs?.isSample && (
                    <span className="text-[9px] px-1 py-0.2 rounded border border-dashed border-[#B8B2A7] text-[#57534E] normal-case">
                      Sample
                    </span>
                  )}
                </div>
                <div className="flex items-baseline gap-2 mt-0.5 flex-wrap">
                  <span className="text-lg lg:text-xl font-bold font-mono-num text-[#141413]">
                    {latestObs
                      ? formatCurrency(latestObs.price, garment.currency)
                      : 'No price seen'}
                  </span>
                  <span className="text-[10px] text-[#8C857B] font-mono-num whitespace-nowrap">
                    Paid: {purchase[0]?.value ?? 'not entered'}
                  </span>
                </div>
              </div>

              <div className="text-right shrink-0 pl-2.5 border-l border-[#E7E2DA] space-y-1">
                <div>
                  <div className="text-[10px] text-[#8C857B]">Net if sold</div>
                  <div
                    className="text-xs font-mono-num font-bold text-[#141413]"
                    data-testid="hero-net-payout"
                  >
                    {net.kind === 'net'
                      ? formatCurrency(net.net, garment.currency)
                      : net.kind === 'fee_not_confirmed'
                        ? 'Check fees'
                        : 'Not set'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={toggleAddQuote}
                  data-testid="hero-add-price-btn"
                  className="px-2 py-0.5 rounded bg-[#FFF3EB] hover:bg-[#F37021] text-[#B8460F] hover:text-white border border-[#F37021]/30 text-[10px] font-semibold inline-flex items-center gap-0.5 transition-colors whitespace-nowrap"
                >
                  <Plus className="w-2.5 h-2.5" />
                  <span>Price</span>
                </button>
              </div>
            </div>

            {/* 3-Tab Segmented IA Navigation */}
            <div
              role="tablist"
              aria-label="Garment inspection sections"
              data-testid="inspector-ia-tabs"
              className="grid grid-cols-3 gap-1 bg-[#EDE9E1] p-1 rounded-xl"
            >
              {(
                [
                  {
                    id: 'market',
                    label: 'Market & Chart',
                    badge: `${sortedComps.length}`,
                  },
                  {
                    id: 'wear',
                    label: 'Wear & Outfits',
                    badge: `${keepScenario.matchingLooks.length}`,
                  },
                  {
                    id: 'decide',
                    label: 'Keep vs Sell',
                    badge: '30D',
                  },
                ] as const
              ).map((tab) => {
                const active = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    data-testid={`ia-tab-${tab.id}`}
                    onClick={() => {
                      setActiveTab(tab.id);
                      bodyRef.current?.scrollTo({ top: 0 });
                    }}
                    className={`py-1.5 px-2 rounded-lg text-xs font-semibold transition-all flex items-center justify-center gap-1.5 whitespace-nowrap ${
                      active
                        ? 'bg-white text-[#141413] shadow-xs border border-[#E7E2DA]'
                        : 'text-[#57534E] hover:text-[#141413]'
                    }`}
                  >
                    <span>{tab.label}</span>
                    <span
                      className={`text-[10px] font-mono-num px-1.5 py-0.2 rounded-full ${
                        active
                          ? 'bg-[#FFF3EB] text-[#B8460F]'
                          : 'bg-white/70 text-[#8C857B]'
                      }`}
                    >
                      {tab.badge}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Scrollable Tabbed Body */}
          <div
            ref={bodyRef}
            className="inspector-body flex-1 min-h-0 overflow-y-auto px-5 py-3.5 space-y-3.5"
          >
            {/* TAB 1: MARKET & CHART (Default Active — Price Trajectory & Platform Records Front & Center) */}
            {activeTab === 'market' && (
              <div className="space-y-3.5" data-testid="inspector-tab-market">
                {showAddQuote && (
                  <form
                    ref={quoteFormRef}
                    onSubmit={handleQuoteSubmit}
                    className="p-3.5 rounded-xl border border-[#F37021] bg-[#FFF3EB]/60 space-y-2.5 scroll-mt-2"
                    data-testid="add-price-form"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-[#141413]">
                        Add a Price You Saw ({garment.currency} platforms only)
                      </span>
                      <button
                        type="button"
                        onClick={() => setShowAddQuote(false)}
                        className="text-xs text-[#57534E] hover:text-[#141413]"
                      >
                        Cancel
                      </button>
                    </div>

                    <div className="grid grid-cols-2 gap-2.5">
                      <div>
                        <label
                          htmlFor="quote-platform"
                          className="block text-[11px] text-[#57534E] mb-1"
                        >
                          Platform
                        </label>
                        <select
                          id="quote-platform"
                          value={quotePlatform}
                          onChange={(e) =>
                            setQuotePlatform(e.target.value as ResalePlatform)
                          }
                          className="w-full px-2.5 py-1.5 text-xs bg-white border border-[#E7E2DA] rounded-lg text-[#141413]"
                        >
                          {quotePlatformOptions.map((p) => (
                            <option key={p.name} value={p.name}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label
                          htmlFor="quote-kind"
                          className="block text-[11px] text-[#57534E] mb-1"
                        >
                          Price Type
                        </label>
                        <select
                          id="quote-kind"
                          value={quoteKind}
                          onChange={(e) =>
                            setQuoteKind(e.target.value as 'traded' | 'listed')
                          }
                          className="w-full px-2.5 py-1.5 text-xs bg-white border border-[#E7E2DA] rounded-lg text-[#141413]"
                        >
                          <option value="listed">Active Listing (Ask)</option>
                          <option value="traded">Traded (I saw it sell)</option>
                        </select>
                      </div>
                    </div>

                    <div className="flex items-end gap-2">
                      <div className="flex-1">
                        <label
                          htmlFor="quote-price"
                          className="block text-[11px] text-[#57534E] mb-1"
                        >
                          Price Seen ({garment.currency})
                        </label>
                        <input
                          id="quote-price"
                          type="number"
                          step="any"
                          placeholder={garment.currency === 'KRW' ? '285000' : '220'}
                          value={quotePrice}
                          onChange={(e) => setQuotePrice(e.target.value)}
                          className="w-full px-3 py-1.5 text-xs font-mono-num bg-white border border-[#E7E2DA] rounded-lg text-[#141413]"
                        />
                      </div>
                      <button
                        type="submit"
                        className="px-4 py-1.5 text-xs font-semibold bg-[#F37021] text-white rounded-lg hover:bg-[#D95D12] transition-colors whitespace-nowrap"
                      >
                        Add Price
                      </button>
                    </div>

                    {quoteError && (
                      <p className="text-xs text-red-600 font-medium">{quoteError}</p>
                    )}
                  </form>
                )}

                <section
                  ref={chartRef}
                  aria-label="Market prices"
                  data-testid="inspector-market"
                  className="scroll-mt-2"
                >
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <h3 className="text-xs font-semibold tracking-wide uppercase text-[#57534E]">
                      Market · Prices on Record
                    </h3>
                    {hasPriceBasis && askPrice !== null && (
                      <button
                        type="button"
                        onClick={jumpToAskTools}
                        className="text-[11px] font-semibold text-[#B8460F] hover:underline whitespace-nowrap"
                      >
                        Adjust Ask &amp; Fees →
                      </button>
                    )}
                  </div>
                  <KalshiPriceChart
                    garment={garment}
                    observations={garment.observations}
                    currency={garment.currency}
                    window={chartWindow}
                    onWindowChange={setChartWindow}
                    purchasePrice={garment.purchasePrice}
                    simulatedAskPrice={askPrice}
                    tradedBandMin={sellScenario.tradedBandMin}
                    tradedBandMax={sellScenario.tradedBandMax}
                    tradedCount={sellScenario.traded.count}
                    excludedObsIds={excludedObsIds}
                    onToggleExcludeObs={handleToggleExcludeObs}
                  />
                </section>

                {/* Price seen: the latest record per platform (up to 3), trade vs ask, Sample marked */}
                <div
                  className="border border-[#E7E2DA] rounded-xl p-3 bg-white space-y-2"
                  data-testid="inspector-price-seen"
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-xs font-bold text-[#141413] whitespace-nowrap">
                      Price Seen · Latest Per Platform
                    </span>
                    <span className="text-[10px] font-mono-num text-[#57534E] bg-[#FFF3EB] px-1.5 py-0.5 rounded border border-[#F37021]/30 whitespace-nowrap shrink-0">
                      Counted prices
                    </span>
                  </div>

                  {sellScenario.status === 'prices_counted' ? (
                    <div className="space-y-1.5">
                      {priceSeen.rows.length > 0 && (
                        <ul className="space-y-1" data-testid="inspector-price-rows">
                          {priceSeen.rows.map((row) => (
                            <li
                              key={row.platform}
                              className="flex items-center justify-between gap-2 text-[11px] bg-[#FAF8F5] px-2 py-1.5 rounded border border-[#E7E2DA]"
                              data-testid={`inspector-price-row-${row.platform}`}
                            >
                              <span className="min-w-0 flex items-center gap-1.5">
                                <span className="font-semibold text-[#141413] truncate">
                                  {row.platform}
                                </span>
                                <span
                                  className={`text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap ${
                                    row.kind === 'traded'
                                      ? 'bg-[#F37021] text-white'
                                      : 'border border-[#141413] text-[#141413] bg-white'
                                  }`}
                                >
                                  {row.kind === 'traded' ? '● Trade' : '○ Ask'}
                                </span>
                                {row.isSample && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded border border-dashed border-[#B8B2A7] text-[#57534E] whitespace-nowrap">
                                    Sample
                                  </span>
                                )}
                              </span>
                              <span className="text-right shrink-0 font-mono-num whitespace-nowrap">
                                <span className="font-semibold text-[#141413]">
                                  {formatCurrency(row.price, row.currency)}
                                </span>{' '}
                                <span className="text-[10px] text-[#8C857B]">{row.date}</span>
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}

                      <div className="flex items-center gap-1.5 flex-wrap text-[11px] text-[#57534E]">
                        <span
                          className="font-bold text-[#F37021] whitespace-nowrap"
                          data-testid="sell-traded-count"
                        >
                          <span className="font-mono-num">
                            {sellScenario.traded.count}
                          </span>{' '}
                          {sellScenario.traded.count === 1 ? 'trade' : 'trades'}
                        </span>
                        <span>
                          ·{' '}
                          <span className="font-mono-num">{sellScenario.listed.count}</span>{' '}
                          {sellScenario.listed.count === 1 ? 'ask' : 'asks'} on record ·{' '}
                          <span className="font-mono-num">{priceSeen.platformCount}</span>{' '}
                          {priceSeen.platformCount === 1 ? 'platform' : 'platforms'}
                        </span>
                        <button
                          type="button"
                          aria-label="Show what was counted for prices"
                          data-testid="sell-likelihood-info-btn"
                          onClick={() => setShowSellProvenance((v) => !v)}
                          className="p-0.5 rounded-full text-[#8C857B] hover:text-[#F37021] hover:bg-[#FFF3EB] transition-colors"
                          title="Show the price records that were counted"
                        >
                          <Info className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      {showSellProvenance && (
                        <div
                          className="p-2 rounded-lg bg-[#FFF3EB]/70 border border-[#F37021]/40 text-[10px] text-[#57534E] leading-relaxed"
                          data-testid="sell-likelihood-provenance-tooltip"
                        >
                          <div className="font-semibold text-[#141413]">
                            On record: {plural(sellScenario.traded.count, 'trade')} (
                            {sellScenario.traded.last60dCount} in the last 60 days) ·{' '}
                            {plural(sellScenario.listed.count, 'ask')}
                          </div>
                          <div className="mt-0.5 font-mono-num">
                            {describeRecordCount('trade', sellScenario.traded)} ·{' '}
                            {describeRecordCount('ask', sellScenario.listed)}. No
                            records of listings that did not sell.
                          </div>
                        </div>
                      )}

                      <div className="text-[10px] text-[#8C857B] flex items-center justify-between gap-2 flex-wrap">
                        <span>Chance of selling: not computed (no unsold-listing records)</span>
                        <button
                          type="button"
                          data-testid="inspector-see-all-prices"
                          onClick={jumpToChart}
                          className="text-[#F37021] hover:underline font-medium whitespace-nowrap"
                        >
                          Chart ({plural(priceSeen.recordCount, 'record')})
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div
                      className="p-2.5 rounded-lg bg-[#FAF8F5] border border-[#E7E2DA] text-[11px] text-[#57534E]"
                      data-testid="no-price-records-notice"
                    >
                      <div className="font-semibold text-[#141413]">
                        No price on record
                      </div>
                      <p className="text-[10px] text-[#8C857B] mt-0.5 leading-normal">
                        Chance of selling is not computed.
                      </p>
                    </div>
                  )}

                  <div className="pt-1.5 border-t border-[#E7E2DA] flex items-center justify-between gap-2">
                    <span className="text-[10px] text-[#8C857B]">
                      {garment.currency} platforms only · never averaged or converted
                    </span>
                    <button
                      type="button"
                      onClick={toggleAddQuote}
                      data-testid="add-price-seen-btn"
                      aria-expanded={showAddQuote}
                      className="inline-flex items-center gap-1 text-xs font-medium text-[#F37021] hover:underline whitespace-nowrap"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Add a Price You Saw</span>
                    </button>
                  </div>
                </div>

                {/* Purchase info: only what the owner entered; blank lines stay "not entered" */}
                <section
                  className="border border-[#E7E2DA] rounded-xl px-3.5 py-3 bg-white"
                  data-testid="inspector-purchase"
                  aria-label="Purchase info"
                >
                  <div className="text-[11px] font-medium text-[#8C857B] tracking-wide">
                    PURCHASE · WHAT YOU ENTERED
                  </div>
                  <dl className="mt-1.5 grid grid-cols-3 gap-2 text-[11px]">
                    {purchase.map((line) => (
                      <div key={line.label} className="min-w-0">
                        <dt className="text-[10px] text-[#8C857B]">{line.label}</dt>
                        <dd
                          className={
                            line.entered
                              ? 'font-mono-num font-semibold text-[#141413] truncate'
                              : 'text-[#8C857B] italic'
                          }
                          data-testid={`inspector-purchase-${line.label.toLowerCase()}`}
                        >
                          {line.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              </div>
            )}

            {/* TAB 2: WEAR & OUTFITS (Photo Showcase + Counted Wear Log + Target Looks & Schedule) */}
            {activeTab === 'wear' && (
              <div className="space-y-3.5" data-testid="inspector-tab-wear">
                {/* Photo (Front / Rail toggle when the piece has both photos) + inline photo upload */}
                <div
                  className="bg-[#FAF8F5] border border-[#E7E2DA] rounded-xl p-3 space-y-2"
                  data-testid="front-shot-showcase"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs text-[#57534E] truncate">
                      <span className="font-semibold text-[#141413]">{photoLabel}</span>
                      <span aria-hidden="true"> · </span>
                      <span>{garment.fabricLabel}</span>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      {onUpdateGarmentPhoto && (
                        <>
                          <input
                            ref={inlinePhotoInputRef}
                            type="file"
                            accept="image/*"
                            onChange={handleInlinePhotoUpload}
                            className="hidden"
                            aria-label="Replace garment photo"
                          />
                          <button
                            type="button"
                            onClick={() => inlinePhotoInputRef.current?.click()}
                            className="px-2 py-1 rounded-md bg-white border border-[#E7E2DA] hover:border-[#F37021] text-[10px] font-semibold text-[#141413] inline-flex items-center gap-1 transition-colors"
                            title="Replace this garment's photo with your own (kept as is, no model call)"
                          >
                            <Upload className="w-3 h-3 text-[#F37021]" />
                            <span>Upload Photo</span>
                          </button>
                        </>
                      )}

                      {twoPhotos && (
                        <div
                          className="flex items-center bg-white border border-[#E7E2DA] rounded-lg p-0.5 shrink-0"
                          role="group"
                          aria-label="Garment camera angle"
                          data-testid="inspector-photo-toggle"
                        >
                          <button
                            type="button"
                            onClick={() => {
                              setImgFailed(false);
                              setPhotoAngle('front');
                            }}
                            className={`px-2 py-0.5 text-[11px] font-semibold rounded-md transition-colors whitespace-nowrap ${
                              photoAngle === 'front'
                                ? 'bg-[#F37021] text-white'
                                : 'text-[#57534E] hover:text-[#141413]'
                            }`}
                          >
                            Front
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setImgFailed(false);
                              setPhotoAngle('side');
                            }}
                            className={`px-2 py-0.5 text-[11px] font-semibold rounded-md transition-colors whitespace-nowrap ${
                              photoAngle === 'side'
                                ? 'bg-[#F37021] text-white'
                                : 'text-[#57534E] hover:text-[#141413]'
                            }`}
                          >
                            Rail
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="w-full h-40 rounded-lg bg-white border border-[#E7E2DA] overflow-hidden flex items-center justify-center relative">
                    {activePhotoUrl && !imgFailed ? (
                      <img
                        src={activePhotoUrl}
                        alt={`${garment.brand} ${garment.name} (${photoAngle} view)`}
                        referrerPolicy="no-referrer"
                        onError={() => setImgFailed(true)}
                        className="w-full h-full object-contain p-1.5 transition-transform duration-200"
                      />
                    ) : (
                      <div
                        className="w-full h-full flex flex-col items-center justify-center p-4 text-center"
                        style={{ backgroundColor: `${garment.colorHex}18` }}
                      >
                        <span
                          className="w-10 h-10 rounded-full border border-black/10 mb-1.5"
                          style={{ backgroundColor: garment.colorHex }}
                        />
                        <span className="text-xs font-mono-num font-semibold text-[#141413]">
                          {[garment.code, garment.brand].filter(Boolean).join(' · ')}
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center justify-between text-[10px] text-[#8C857B]">
                    <span>3D Boutique Fixture: {displayVariant.fixtureTitle}</span>
                    {!garment.isSample && (
                      <button
                        type="button"
                        onClick={() => onToggleTodayLock(garment.id)}
                        className={`px-2 py-0.5 rounded border font-semibold inline-flex items-center gap-1 transition-colors ${
                          garment.lockedForToday
                            ? 'bg-[#141413] text-white border-[#141413]'
                            : 'bg-white text-[#57534E] border-[#E7E2DA] hover:text-[#141413]'
                        }`}
                      >
                        <Lock className="w-2.5 h-2.5" />
                        <span>{garment.lockedForToday ? 'Locked for Today' : 'Pin to Today'}</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Wear record (If Kept · Counted wears) */}
                <div
                  className="border border-[#E7E2DA] rounded-xl p-3.5 bg-white space-y-2.5"
                  data-testid="scenario-card-keep"
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-xs font-bold text-[#141413] whitespace-nowrap">
                      Keep · If Kept
                    </span>
                    <span className="text-[10px] font-mono-num text-[#8C857B] bg-[#FAF8F5] px-1.5 py-0.5 rounded border border-[#E7E2DA] whitespace-nowrap shrink-0">
                      Counted wears
                    </span>
                  </div>

                  {wear.kind === 'counted' && keepScenario.wearsLast60Days !== null ? (
                    <div className="space-y-1.5">
                      <div className="text-sm text-[#141413] leading-snug">
                        <span data-testid="inspector-wear-line">
                          <span
                            className="font-bold whitespace-nowrap"
                            data-testid="keep-wear-count"
                          >
                            <span className="font-mono-num">
                              {keepScenario.wearsLast60Days}
                            </span>{' '}
                            {keepScenario.wearsLast60Days === 1 ? 'wear' : 'wears'}
                          </span>{' '}
                          <span className="text-[#57534E]">
                            · 60 days · last worn{' '}
                            <span className="font-mono-num">
                              {keepScenario.lastWornDate ?? 'date unknown'}
                            </span>
                          </span>{' '}
                          <span className="text-[11px] text-[#8C857B] whitespace-nowrap">
                            ({wearDaysText})
                          </span>
                        </span>{' '}
                        <button
                          type="button"
                          aria-label="Show what was counted for wears"
                          data-testid="keep-likelihood-info-btn"
                          onClick={() => setShowKeepProvenance((v) => !v)}
                          className="inline-flex align-middle p-0.5 rounded-full text-[#8C857B] hover:text-[#F37021] hover:bg-[#FFF3EB] transition-colors"
                          title="Show the records that were counted"
                        >
                          <Info className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      {showKeepProvenance && (
                        <div
                          className="p-2 rounded-lg bg-[#FAF8F5] border border-[#C5A572]/50 text-[10px] text-[#57534E] leading-relaxed"
                          data-testid="keep-likelihood-provenance-tooltip"
                        >
                          <div className="font-semibold text-[#141413]">
                            {plural(keepScenario.wearsLast60Days, 'wear')} logged in
                            the last 60 days &amp;{' '}
                            {plural(keepScenario.matchingLooks.length, 'target look')}
                          </div>
                          <div className="mt-0.5">
                            Last worn {keepScenario.lastWornDate ?? 'date unknown'} (
                            {wearDaysText}). Whether it will be worn again is not
                            computed.
                          </div>
                        </div>
                      )}

                      <div className="text-[10px] text-[#8C857B] flex items-center justify-between gap-2">
                        <span>Future wear: not computed</span>
                        <button
                          type="button"
                          onClick={() => setShowKeepProvenance((v) => !v)}
                          className="text-[#F37021] hover:underline font-medium whitespace-nowrap"
                        >
                          {showKeepProvenance ? 'Hide records' : 'Records ⓘ'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div
                      className="p-2.5 rounded-lg bg-[#FAF8F5] border border-[#E7E2DA] text-[11px] text-[#57534E]"
                      data-testid="insufficient-wear-log-notice"
                    >
                      <div className="font-semibold text-[#141413]" data-testid="inspector-wear-line">
                        No wear log
                      </div>
                      <p className="text-[10px] text-[#8C857B] mt-0.5 leading-normal">
                        Without a wear log, wears are not counted (unknown, not 0).
                      </p>
                    </div>
                  )}

                  {/* Matching Outfit / Target Look Preview */}
                  <div className="pt-2 border-t border-[#E7E2DA] text-[11px]">
                    <div className="text-[#8C857B] font-medium">
                      Target Looks With This Piece ({keepScenario.matchingLooks.length})
                    </div>
                    {keepScenario.matchingLooks.length > 0 ? (
                      <div className="mt-1.5 space-y-1.5">
                        {keepScenario.matchingLooks.map((look) => (
                          <div
                            key={look.id}
                            className="flex items-center justify-between gap-2 text-[11px] bg-[#FAF8F5] px-2.5 py-1.5 rounded-lg border border-[#E7E2DA]"
                          >
                            <div className="min-w-0">
                              <div className="font-medium text-[#141413] truncate">
                                {look.title}
                              </div>
                              <div className="text-[10px] text-[#8C857B] font-mono-num">
                                {look.pieceIds.join(' + ')}
                              </div>
                            </div>
                            {onLockLookForToday && !garment.isSample && (
                              <button
                                type="button"
                                onClick={() => onLockLookForToday(look.pieceIds)}
                                className="px-2 py-1 rounded bg-white hover:bg-[#141413] text-[#141413] hover:text-white border border-[#E7E2DA] text-[10px] font-semibold shrink-0 transition-colors"
                              >
                                Lock Look
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-[10px] text-[#8C857B] mt-0.5">
                        No target look includes this piece
                      </div>
                    )}
                  </div>

                  {keepScenario.upcomingOccasions.length > 0 && (
                    <div className="pt-2 border-t border-[#E7E2DA] space-y-1">
                      <div className="text-[11px] font-medium text-[#8C857B] flex items-center gap-1">
                        <Clock className="w-3 h-3 text-[#F37021]" />
                        <span>Upcoming Schedule</span>
                      </div>
                      <ul className="space-y-0.5 text-[11px] text-[#57534E]">
                        {keepScenario.upcomingOccasions.map((occ, i) => (
                          <li key={i} className="flex items-center gap-1.5">
                            <Calendar className="w-3 h-3 text-[#C5A572] shrink-0" />
                            <span>{occ}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                {/* 4-Step Provenance Strip */}
                <div className="bg-[#FFF3EB] border border-[#F37021]/30 rounded-xl px-3.5 py-2.5 space-y-2">
                  <div className="min-w-0">
                    <div className="text-[11px] font-semibold text-[#F37021] flex items-center gap-1">
                      <Sparkles className="w-3.5 h-3.5 shrink-0" />
                      <span>CLOSER DECISION STUDIO · COUNTED RECORDS</span>
                    </div>
                    <div className="text-xs font-semibold text-[#141413] mt-0.5">
                      “{summary.coreQuestion}”
                    </div>
                  </div>

                  <div
                    className="pt-1.5 border-t border-[#F37021]/20 flex flex-wrap items-center justify-between gap-1 text-[10px] text-[#57534E]"
                    data-testid="verifiable-loop-strip"
                  >
                    <span className="inline-flex items-center gap-1 font-medium text-[#141413]">
                      <Info className="w-3 h-3 text-[#F37021]" />
                      <span data-testid="photo-provenance">① {photoSource}</span>
                    </span>
                    <span aria-hidden="true">→</span>
                    <span>{priceStep}</span>
                    <span aria-hidden="true">→</span>
                    <span>③ Code counts</span>
                    <span aria-hidden="true">→</span>
                    <span className="font-mono-num font-semibold text-[#F37021]">
                      {garment.lastDecision
                        ? `④ ${storageNote}`
                        : '④ No decision yet'}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 3: KEEP VS SELL (Counted Comparison + Fee Verification + Ask Slider + Listing Draft) */}
            {activeTab === 'decide' && (
              <div className="space-y-3.5" data-testid="inspector-tab-decide">
                <section
                  className="border border-[#E7E2DA] rounded-xl p-3.5 bg-[#FAF8F5] space-y-3"
                  data-testid="kalshi-dual-scenario-board"
                  aria-label="Counted records"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <h3 className="text-xs font-semibold text-[#141413]">
                        Keep? vs Sell? · Counted Records
                      </h3>
                      <p className="text-[10px] text-[#8C857B]">
                        Both sides show counted records only. No probability is computed.
                      </p>
                    </div>
                    <span className="text-[10px] font-mono-num px-2 py-0.5 rounded bg-white border border-[#E7E2DA] text-[#57534E] whitespace-nowrap shrink-0">
                      As of {displayDate}
                    </span>
                  </div>

                  {/* Side-by-side compact summary cards */}
                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="border border-[#E7E2DA] rounded-xl p-2.5 bg-white space-y-1">
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-[#8C857B]">
                        If Kept · 60D
                      </div>
                      <div className="text-sm font-bold font-mono-num text-[#141413]">
                        {wear.kind === 'counted' && keepScenario.wearsLast60Days !== null
                          ? plural(keepScenario.wearsLast60Days, 'wear')
                          : 'No wear log'}
                      </div>
                      <div className="text-[10px] text-[#57534E]">
                        {plural(keepScenario.matchingLooks.length, 'target look')}
                      </div>
                    </div>

                    <div className="border border-[#F37021]/40 rounded-xl p-2.5 bg-white space-y-1">
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-[#B8460F]">
                        If Listed · {garment.currency}
                      </div>
                      <div className="text-sm font-bold font-mono-num text-[#141413]">
                        {net.kind === 'net'
                          ? formatCurrency(net.net, garment.currency)
                          : askPrice !== null
                            ? `Ask ${formatCurrency(askPrice, garment.currency)}`
                            : 'Ask not set'}
                      </div>
                      <div className="text-[10px] text-[#57534E]">
                        {plural(sellScenario.traded.count, 'trade')} · {plural(sellScenario.listed.count, 'ask')}
                      </div>
                    </div>
                  </div>

                  {/* Net if sold: only once every cost line is ticked; "not set" with no price on record */}
                  <div
                    className="border border-[#F37021]/45 rounded-xl p-3 bg-white space-y-2"
                    data-testid="scenario-card-sell"
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-xs font-bold text-[#F37021] whitespace-nowrap">
                        Sell · If Listed
                      </span>
                      <span className="text-[10px] font-mono-num text-[#57534E] bg-[#FFF3EB] px-1.5 py-0.5 rounded border border-[#F37021]/30 whitespace-nowrap shrink-0">
                        Net if sold
                      </span>
                    </div>

                    <p className="text-[11px] text-[#57534E] flex items-center justify-between gap-2 flex-wrap">
                      <span>
                        Ask{' '}
                        <strong
                          className="font-mono-num text-[#141413]"
                          data-testid="sell-ask-price"
                        >
                          {askPrice !== null
                            ? formatCurrency(askPrice, garment.currency)
                            : 'not set'}
                        </strong>
                        {askPrice !== null && (
                          <span className="text-[#8C857B]">
                            {' '}
                            ·{' '}
                            {sellScenario.askDeltaPctFromLatest === null
                              ? anchorIsLatest
                                ? 'latest price seen'
                                : 'your purchase price'
                              : sellScenario.askDeltaPctFromLatest === 0
                                ? 'latest price seen'
                                : `${sellScenario.askDeltaPctFromLatest > 0 ? '+' : ''}${sellScenario.askDeltaPctFromLatest}% vs latest`}
                          </span>
                        )}
                      </span>
                    </p>

                    <div className="space-y-1 text-[11px]" data-testid="inspector-net-if-sold">
                      <div className="text-[#57534E]">
                        {net.kind !== 'no_price' ? (
                          <>
                            If it sells at{' '}
                            <span className="font-mono-num">
                              {formatCurrency(net.ask, garment.currency)}
                            </span>
                            , you receive
                          </>
                        ) : (
                          'No price on record, so no payout is computed'
                        )}
                      </div>
                      {net.kind === 'net' ? (
                        <div>
                          <div
                            className="font-mono-num font-bold text-[#141413] text-base whitespace-nowrap"
                            data-testid="verified-net-payout"
                          >
                            {formatCurrency(net.net, garment.currency)}
                          </div>
                          <div className="text-[10px] text-[#8C857B]">
                            Based on the costs you checked · not a guarantee
                          </div>
                        </div>
                      ) : net.kind === 'fee_not_confirmed' ? (
                        <div
                          className="text-[11px] font-semibold text-[#141413]"
                          data-testid="unconfirmed-net-notice"
                        >
                          Fee not confirmed (tick both cost lines below)
                        </div>
                      ) : null}

                      {sellScenario.tradedBandMin !== null &&
                        sellScenario.tradedBandMax !== null && (
                          <div className="text-[10px] text-[#8C857B]">
                            Trade range · all platforms ({plural(sellScenario.traded.count, 'trade')}){' '}
                            <span className="font-mono-num text-[#57534E] whitespace-nowrap">
                              {formatCurrency(sellScenario.tradedBandMin, garment.currency)} –{' '}
                              {formatCurrency(sellScenario.tradedBandMax, garment.currency)}
                            </span>
                          </div>
                        )}
                    </div>

                    {hasPriceBasis && askPrice !== null && (
                      <div className="pt-1.5 border-t border-[#E7E2DA] text-[11px]">
                        <div className="flex flex-col gap-1" data-testid="fee-line-checks">
                          <label className="inline-flex items-center gap-1.5 text-[#57534E] cursor-pointer select-none">
                            <input
                              type="checkbox"
                              data-testid="fee-rate-confirm"
                              checked={garment.feeConfig.feeRateConfirmed === true}
                              onChange={(e) =>
                                onUpdateFeeConfig(
                                  garment.id,
                                  e.target.checked,
                                  garment.feeConfig.shippingConfirmed === true,
                                )
                              }
                              className="accent-[#F37021] rounded"
                            />
                            <span>
                              {garment.feeConfig.platform} fee{' '}
                              {garment.feeConfig.feeRatePct}% · checked by me
                            </span>
                          </label>
                          <label className="inline-flex items-center gap-1.5 text-[#57534E] cursor-pointer select-none">
                            <input
                              type="checkbox"
                              data-testid="shipping-confirm"
                              checked={garment.feeConfig.shippingConfirmed === true}
                              onChange={(e) =>
                                onUpdateFeeConfig(
                                  garment.id,
                                  garment.feeConfig.feeRateConfirmed === true,
                                  e.target.checked,
                                )
                              }
                              className="accent-[#F37021] rounded"
                            />
                            <span>
                              Shipping{' '}
                              {formatCurrency(
                                garment.feeConfig.shippingCost,
                                garment.currency,
                              )}{' '}
                              · checked by me
                            </span>
                          </label>
                          {!garment.feeConfig.confirmed && (
                            <span
                              className="text-[10px] text-[#8C857B]"
                              data-testid="fee-not-confirmed"
                            >
                              Fee not confirmed until both lines are ticked
                            </span>
                          )}
                        </div>
                      </div>
                    )}

                    {!hasPriceBasis && (
                      <div
                        className="border border-dashed border-[#D9D3C9] rounded-lg p-2.5 bg-[#FAF8F4] text-[11px] text-[#57534E] flex items-center justify-between gap-2"
                        data-testid="no-price-basis"
                      >
                        <span>
                          No price on record · ask not set. Add a price you saw first.
                        </span>
                        <button
                          type="button"
                          onClick={toggleAddQuote}
                          className="px-2.5 py-1 rounded bg-[#F37021] text-white text-[10px] font-semibold shrink-0 whitespace-nowrap"
                        >
                          + Add Price
                        </button>
                      </div>
                    )}
                  </div>
                </section>

                {/* Ask-price slider + D3 draggable handle -> recomputes payout IF sold */}
                {hasPriceBasis && askPrice !== null && (
                  <div
                    ref={askSimulatorRef}
                    className="border border-[#E7E2DA] rounded-xl p-3 bg-white space-y-2.5 scroll-mt-2"
                    data-testid="ask-price-simulator"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <div className="text-xs font-semibold text-[#141413]">
                          Ask Price Slider · Payout If Sold
                        </div>
                        <div className="text-[10px] text-[#8C857B]">
                          Slide or drag the handle below (chance of sale not computed)
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-xs font-mono-num font-bold text-[#F37021]">
                          Ask {formatCurrency(askPrice, garment.currency)}
                          {sellScenario.askDeltaPctFromLatest !== null
                            ? ` (${sellScenario.askDeltaPctFromLatest >= 0 ? '+' : ''}${sellScenario.askDeltaPctFromLatest}% vs latest)`
                            : ''}
                        </div>
                        <div className="text-[10px] font-mono-num text-[#141413]">
                          You receive:{' '}
                          <strong>
                            {sellScenario.netPayoutInfo.netPayout !== null
                              ? formatCurrency(
                                  sellScenario.netPayoutInfo.netPayout,
                                  garment.currency,
                                )
                              : 'fee not confirmed'}
                          </strong>
                        </div>
                      </div>
                    </div>

                    <input
                      type="range"
                      aria-label="Adjust target selling ask price"
                      data-testid="ask-price-slider"
                      min={sliderMin}
                      max={sliderMax}
                      step={sliderStep}
                      value={askPrice}
                      onChange={(e) => setSimulatedAskPrice(Number(e.target.value))}
                      className="w-full accent-[#F37021] cursor-pointer"
                    />

                    <div className="flex items-center justify-between gap-1.5">
                      {askPresets.map((preset) => (
                        <button
                          key={preset.label}
                          type="button"
                          onClick={() => setSimulatedAskPrice(preset.price)}
                          className={`flex-1 py-1 px-2 rounded-md border text-[10px] font-medium transition-colors whitespace-nowrap ${
                            Math.abs(askPrice - preset.price) < sliderStep
                              ? 'bg-[#141413] text-white border-[#141413]'
                              : 'bg-[#FAF8F5] text-[#57534E] border-[#E7E2DA] hover:text-[#141413]'
                          }`}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>

                    <div className="rounded-lg bg-[#FAF8F5] border border-[#E7E2DA] p-1.5">
                      <div className="flex items-center justify-between gap-1 text-[9px] text-[#8C857B] px-1 mb-0.5">
                        <span className="whitespace-nowrap">
                          Prices on record · trade ● ask ○
                        </span>
                        <span className="text-[#F37021] font-medium whitespace-nowrap">
                          ↕ Drag to set ask
                        </span>
                      </div>
                      <svg
                        ref={d3SvgRef}
                        viewBox={`0 0 ${d3Width} ${d3Height}`}
                        data-testid="d3-sell-handle-chart"
                        className="w-full h-20 overflow-visible select-none cursor-ns-resize"
                        onPointerDown={(e) => {
                          isDraggingHandleRef.current = true;
                          e.currentTarget.setPointerCapture(e.pointerId);
                          updateAskFromSvgClientY(e.clientY);
                        }}
                        onPointerMove={(e) => {
                          if (!isDraggingHandleRef.current) return;
                          updateAskFromSvgClientY(e.clientY);
                        }}
                        onPointerUp={(e) => {
                          isDraggingHandleRef.current = false;
                          try {
                            e.currentTarget.releasePointerCapture(e.pointerId);
                          } catch {
                            // ignore
                          }
                        }}
                      >
                        {[0.25, 0.5, 0.75].map((r, i) => (
                          <line
                            key={i}
                            x1={d3PadX}
                            x2={d3Width - d3PadX}
                            y1={d3PadY + r * (d3Height - d3PadY * 2)}
                            y2={d3PadY + r * (d3Height - d3PadY * 2)}
                            stroke="#E7E2DA"
                            strokeDasharray="2 2"
                            strokeWidth="1"
                          />
                        ))}

                        {compSeries.map((pt) => (
                          <circle
                            key={pt.obs.id}
                            cx={d3XScale(pt.idx)}
                            cy={d3YScale(pt.price)}
                            r="3"
                            fill={pt.obs.kind === 'traded' ? '#141413' : '#FFFFFF'}
                            stroke="#141413"
                            strokeWidth="1.5"
                          >
                            <title>
                              {`${pt.obs.platform} · ${pt.obs.kind === 'traded' ? 'trade' : 'ask'} ${formatCurrency(pt.price, garment.currency)} (${pt.obs.date})`}
                            </title>
                          </circle>
                        ))}

                        <g
                          data-testid="d3-ask-price-handle"
                          transform={`translate(0, ${askHandleY})`}
                          className="cursor-ns-resize"
                        >
                          <line
                            x1={d3PadX}
                            x2={d3Width - d3PadX}
                            y1={0}
                            y2={0}
                            stroke="#F37021"
                            strokeWidth="1.75"
                            strokeDasharray="3 2"
                          />
                          <rect
                            x={d3Width - 62}
                            y={-9}
                            width={56}
                            height={18}
                            rx={5}
                            fill="#F37021"
                          />
                          <text
                            x={d3Width - 34}
                            y={3}
                            textAnchor="middle"
                            className="fill-white text-[8px] font-mono-num font-bold"
                          >
                            ↕ Ask
                          </text>
                        </g>
                      </svg>
                    </div>
                  </div>
                )}

                {/* L0 Listing Draft Copy */}
                <div
                  className="border border-[#E7E2DA] rounded-xl p-3.5 bg-white space-y-1.5"
                  data-testid="inspector-listing-draft"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold text-[#141413]">
                      L0 Listing Draft · Unverified Fields Guarded with [VERIFY]
                    </span>
                    <button
                      type="button"
                      data-testid="copy-listing-draft-btn"
                      onClick={handleCopyListingDraft}
                      className="px-2.5 py-1 rounded bg-[#141413] text-white text-[10px] font-semibold hover:bg-[#F37021] transition-colors inline-flex items-center gap-1 whitespace-nowrap"
                    >
                      {draftCopied === 'copied' ? (
                        <>
                          <Check className="w-3 h-3 text-[#F37021]" />
                          <span>Draft Copied</span>
                        </>
                      ) : draftCopied === 'failed' ? (
                        <span>Copy failed · select the text</span>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" />
                          <span>Copy Listing Draft</span>
                        </>
                      )}
                    </button>
                  </div>
                  <pre className="p-2 rounded bg-[#FAF8F5] border border-[#E7E2DA] text-[10px] font-mono-num text-[#57534E] whitespace-pre-wrap leading-relaxed">
                    {listingDraftText}
                  </pre>
                </div>

                {/* Expandable "Evidence & Limits" Panel */}
                <div
                  className="border border-[#E7E2DA] rounded-xl bg-[#FAF8F5] overflow-hidden"
                  data-testid="wonder-evidence-section"
                >
                  <button
                    type="button"
                    onClick={() => setShowEvidence((v) => !v)}
                    data-testid="wonder-evidence-toggle"
                    className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-[#FFF3EB]/40 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <Info className="w-4 h-4 text-[#F37021]" />
                      <span className="text-xs font-semibold text-[#141413]">
                        Evidence &amp; Limits · Counted by Code (no model call)
                      </span>
                    </div>
                    {showEvidence ? (
                      <ChevronUp className="w-4 h-4 text-[#57534E]" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-[#57534E]" />
                    )}
                  </button>

                  {showEvidence && (
                    <div className="px-4 pb-3.5 pt-1 border-t border-[#E7E2DA] space-y-2.5 text-xs text-[#57534E]">
                      <div className="p-2.5 rounded-lg bg-white border border-[#E7E2DA]">
                        <div className="text-[11px] font-semibold text-[#141413]">
                          Condition Grade · Price Records &amp; Data Limits
                        </div>
                        <p className="text-[11px] text-[#57534E] mt-1 leading-relaxed">
                          Condition:{' '}
                          <strong className="text-[#141413]">
                            {garment.conditionGrade ?? '[VERIFY: Condition Grade]'}
                          </strong>{' '}
                          · Trades on record:{' '}
                          <strong className="font-mono-num text-[#141413]">
                            {sellScenario.traded.count}
                          </strong>{' '}
                          ({sellScenario.traded.last60dCount} in the last 60 days) · Asks
                          on record:{' '}
                          <strong className="font-mono-num text-[#141413]">
                            {sellScenario.listed.count}
                          </strong>{' '}
                          (as of {displayDate}).
                        </p>
                        <p className="text-[10px] text-[#8C857B] mt-1 leading-normal">
                          ※ {summary.limitsNotice}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Sticky bottom action bar: Keep & Style / Prepare to Sell / Decide Later */}
          <div
            className="shrink-0 border-t border-[#E7E2DA] bg-white px-5 pt-2.5 space-y-2 inspector-actions"
            data-testid="inspector-actions"
          >
            <div className="flex flex-wrap items-center justify-between gap-1">
              <span className="text-xs font-semibold text-[#141413]">
                Record Decision · Action
              </span>
              <span
                className="text-[10px] font-medium px-2 py-0.5 rounded bg-[#FFF3EB] border border-[#F37021]/30 text-[#141413] whitespace-nowrap shrink-0"
                data-testid="neutral-decision-badge"
              >
                {summary.neutralBadge}
              </span>
            </div>
            {factsMoved && (
              <div className="text-[11px] font-semibold text-[#F37021]">
                Latest price on record differs from your last decision (
                {garment.lastDecision?.savedAt})
              </div>
            )}

            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                data-testid="action-keep-outfit"
                disabled={garment.isSample}
                title={garment.isSample ? 'Sample piece: no decision is saved' : undefined}
                onClick={() => {
                  if (garment.isSample) return;
                  onSaveDecision(
                    garment.id,
                    'keep',
                    askPrice !== null ? askPrice : undefined,
                  );
                  if (!garment.lockedForToday) {
                    onToggleTodayLock(garment.id);
                  }
                  if (
                    onLockLookForToday &&
                    keepScenario.matchingLooks.length > 0
                  ) {
                    onLockLookForToday(keepScenario.matchingLooks[0].pieceIds);
                  }
                }}
                className={`py-2.5 px-2 rounded-lg text-xs font-semibold border transition-colors flex items-center justify-center gap-1 whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed ${
                  garment.lastDecision?.choice === 'keep'
                    ? 'bg-[#141413] text-white border-[#141413]'
                    : 'bg-[#FAF8F5] text-[#141413] border-[#E7E2DA] hover:border-[#141413]'
                }`}
              >
                {garment.lastDecision?.choice === 'keep' ? (
                  <Check className="w-3.5 h-3.5 text-[#F37021] shrink-0" />
                ) : (
                  <Lock className="w-3.5 h-3.5 text-[#141413] shrink-0" />
                )}
                <span>Keep &amp; Style</span>
              </button>

              <button
                type="button"
                data-testid="action-prepare-sell"
                disabled={garment.isSample}
                title={garment.isSample ? 'Sample piece: no decision is saved' : undefined}
                onClick={() => {
                  if (garment.isSample) return;
                  onSaveDecision(
                    garment.id,
                    'sell',
                    askPrice !== null ? askPrice : undefined,
                  );
                }}
                className={`py-2.5 px-2 rounded-lg text-xs font-semibold border transition-colors flex items-center justify-center gap-1 whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed ${
                  garment.lastDecision?.choice === 'sell'
                    ? 'bg-[#F37021] text-white border-[#F37021]'
                    : 'bg-[#FFF3EB] text-[#F37021] border-[#F37021]/40 hover:bg-[#F37021] hover:text-white'
                }`}
              >
                {garment.lastDecision?.choice === 'sell' ? (
                  <Check className="w-3.5 h-3.5 shrink-0" />
                ) : (
                  <ArrowUpRight className="w-3.5 h-3.5 shrink-0" />
                )}
                <span>Prepare to Sell</span>
              </button>

              <button
                type="button"
                data-testid="action-decide-later"
                onClick={onClose}
                className="py-2.5 px-2 rounded-lg text-xs font-medium bg-white text-[#57534E] border border-[#E7E2DA] hover:text-[#141413] hover:border-[#C5A572] transition-colors flex items-center justify-center whitespace-nowrap"
              >
                <span>Decide Later</span>
              </button>
            </div>

            {garment.isSample ? (
              <div
                className="text-[10px] lg:text-[11px] text-[#57534E] font-mono-num pb-3"
                data-testid="inspector-saved-where"
                title="A sample piece is never added to the owned totals, and no decision is saved for it."
              >
                Sample (Excluded from Owned Total) · no decision is saved
              </div>
            ) : garment.lastDecision ? (
              <div
                className="text-[10px] lg:text-[11px] leading-snug text-[#57534E] font-mono-num pb-3 flex flex-wrap items-center justify-between gap-x-2"
                data-testid="decision-readback"
              >
                <span
                  data-testid="inspector-saved-where"
                  title={persistenceNotice ?? (
                    keptAfterReload
                      ? 'Pieces from a photo scan and their decisions are kept in this browser (localStorage). Nothing is sent to a server.'
                      : 'This decision lives in this browser tab only; a reload resets the sample closet. Nothing is sent to a server.'
                  )}
                >
                  {storageNote} ·{' '}
                  {garment.lastDecision.choice === 'keep'
                    ? 'Keep'
                    : 'Prepare to Sell'}{' '}
                </span>
                <span>
                  Price at decision{' '}
                  {garment.lastDecision.snapshotPrice > 0
                    ? formatCurrency(
                        garment.lastDecision.snapshotPrice,
                        garment.lastDecision.snapshotCurrency,
                      )
                    : 'none'}
                </span>
              </div>
            ) : (
              <div
                className="text-[10px] lg:text-[11px] text-[#57534E] font-mono-num pb-3"
                data-testid="inspector-saved-where"
                title={persistenceNotice ?? (
                  keptAfterReload
                    ? 'Pieces from a photo scan and their decisions are kept in this browser (localStorage). Nothing is sent to a server.'
                    : 'A decision lives in this browser tab only; a reload resets the sample closet. Nothing is sent to a server.'
                )}
              >
                {storageNote}
              </div>
            )}
          </div>
        </div>
      </aside>
    </>
  );
};
