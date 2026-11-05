import React, { useEffect, useMemo, useRef, useState } from 'react';
import gsap from 'gsap';
import {
  ChevronDown,
  ChevronUp,
  Eye,
  Plus,
  RotateCcw,
  Share2,
  SlidersHorizontal,
  UserRound,
} from 'lucide-react';
import { TARGET_LOOKS } from './data/seedCloset';
import { GarmentPiece, ResalePlatform } from './types/closet';
import {
  computeLedgerSummary,
  feeLinesConfirmed,
  formatCurrency,
  getLatestObservation,
  isKeptAfterReload,
} from './utils/ledgerLogic';
import type { SceneViewMode } from './components/BoutiqueRail3D';
import { ClosetGrid } from './components/ClosetGrid';
import { EmptyStage } from './components/EmptyStage';
import { SpaceCallout } from './components/SpaceCallout';
// three.js and the 3D rail load in their own chunk, so the page and the grid view appear sooner.
const BoutiqueRail3D = React.lazy(() => import('./components/BoutiqueRail3D').then((m) => ({ default: m.BoutiqueRail3D })));
import { GarmentInspectDrawer } from './components/GarmentInspectDrawer';
import {
  AddGarmentModal,
  GitHubShareModal,
  LedgerModal,
  LooksModal,
} from './components/ModalsAndViews';
import { ScanPhotoModal } from './components/ScanPhotoModal';
import { ReviewMode } from './components/ReviewMode';
import { reviewCandidates } from './utils/review';
import { useAccountWardrobe } from './hooks/useAccountWardrobe';
import { AccountPanel } from './components/AccountPanel';
import { MarketPulse } from './components/MarketPulse';
import { isPersonalPiece } from './utils/accountWardrobe';
import { preparePiecePhotos, preparePhotoUrl } from './utils/photoUpload';

type FilterTab = 'all' | 'KRW' | 'USD' | 'sell' | 'today';

function todayDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export default function App() {
  const wardrobe = useAccountWardrobe();
  const { pieces: garments, controller } = wardrobe;
  const renderEpoch = wardrobe.epoch;
  const setGarments = (update: GarmentPiece[] | ((previous: GarmentPiece[]) => GarmentPiece[])) => {
    if (controller.getSnapshot().epoch === renderEpoch) controller.update(update);
  };
  const [accountOpen, setAccountOpen] = useState(false);
  const privateView = Boolean(wardrobe.account && !wardrobe.sampleView);
  const mixedGuestView = !wardrobe.account && wardrobe.localCount > 0;
  const activeLooks = privateView ? [] : TARGET_LOOKS;
  const [initialPieceRequest] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    return params.get('piece') || params.get('decide');
  });
  const [initialPieceResolved, setInitialPieceResolved] = useState(!initialPieceRequest);
  const initialPieceScope = useRef<string | null | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<SceneViewMode>(() => {
    if (typeof window === 'undefined') return 'rail';
    const params = new URLSearchParams(window.location.search);
    return params.get('view') === 'vault' ? 'vault' : 'rail';
  });
  // Grid: every piece as a flat card (many pieces, phones). ?layout=grid opens it.
  const [gridView, setGridView] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('layout') === 'grid';
  });
  // 3D fallback: the rail says why it cannot draw (no WebGL 2, a renderer error, reduced motion,
  // ?force2d=1) and the grid takes the stage with a one-line note; leaving the grid clears the note.
  const [renderFallback, setRenderFallback] = useState<string | null>(null);
  useEffect(() => {
    if (!gridView) setRenderFallback(null);
  }, [gridView]);
  // Review: the work mode for comparing the Sell and undecided pieces. ?layout=review opens it.
  const [reviewOpen, setReviewOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('layout') === 'review';
  });
  const [filterTab, setFilterTab] = useState<FilterTab>('all');
  const [railOffset, setRailOffset] = useState<number>(0);
  const [showHangTags, setShowHangTags] = useState<boolean>(true);
  const [showRotationHeatmap, setShowRotationHeatmap] =
    useState<boolean>(true);
  const [dockCollapsed, setDockCollapsed] = useState<boolean>(false);

  const [ledgerOpen, setLedgerOpen] = useState<boolean>(false);
  const [looksOpen, setLooksOpen] = useState<boolean>(false);
  const [addModalOpen, setAddModalOpen] = useState<boolean>(false);
  // The Meta photo scan (Spark + SAM) opens from the design's photo flow, or directly with ?scan=1.
  const [initialScanRequested] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('scan') === '1';
  });
  const [scanOpen, setScanOpen] = useState(false);
  const initialScanResolved = useRef(false);
  const [githubShareOpen, setGithubShareOpen] = useState<boolean>(false);
  const lastIdentityEpoch = useRef(wardrobe.epoch);
  useEffect(() => {
    if (lastIdentityEpoch.current === wardrobe.epoch) return;
    lastIdentityEpoch.current = wardrobe.epoch;
    setSelectedId(null); setFilterTab('all'); setRailOffset(0);
    setLedgerOpen(false); setLooksOpen(false); setAddModalOpen(false);
    setScanOpen(false); setGithubShareOpen(false); setReviewOpen(false);
  }, [wardrobe.epoch]);

  useEffect(() => {
    if (initialScanResolved.current) return;
    const current = controller.getSnapshot();
    if (current.busy || current.status === 'loading') return;
    initialScanResolved.current = true;
    if (initialScanRequested) setScanOpen(true);
  }, [initialScanRequested, wardrobe.busy, wardrobe.status, wardrobe.epoch, controller]);


  // Resolve a reload link once the initial session and its wardrobe have finished loading.
  // The hook starts session lookup before this effect; reading its current snapshot also covers
  // the first render, whose captured React state still says local/not busy.
  useEffect(() => {
    if (initialPieceResolved || !initialPieceRequest) return;
    const current = controller.getSnapshot();
    if (current.account && initialPieceScope.current === undefined) initialPieceScope.current = current.account.workspaceId;
    if (initialPieceScope.current !== undefined && initialPieceScope.current !== (current.account?.workspaceId ?? null)) {
      setInitialPieceResolved(true);
      return;
    }
    if (current.busy || current.status === 'loading' || current.error) return;
    const query = initialPieceRequest.toLowerCase();
    const piece = current.pieces.find(g => g.id.toLowerCase() === query || g.code.toLowerCase() === query);
    setSelectedId(piece?.id ?? null);
    setInitialPieceResolved(true);
  }, [controller, initialPieceRequest, initialPieceResolved, wardrobe.busy, wardrobe.status, wardrobe.error, wardrobe.epoch, garments]);

  // Filtered garments displayed on the 3D rail
  const visibleGarments = useMemo(() => {
    return garments.filter((g) => {
      if (filterTab === 'KRW') return g.currency === 'KRW';
      if (filterTab === 'USD') return g.currency === 'USD';
      if (filterTab === 'sell') return g.lastDecision?.choice === 'sell';
      if (filterTab === 'today') return Boolean(g.lockedForToday);
      return true;
    });
  }, [garments, filterTab]);

  // Complete ledger summary across all garments
  const ledgerSummary = useMemo(
    () => computeLedgerSummary(garments),
    [garments],
  );
  // Pieces marked Sell plus the undecided ones (Sample listed, never summed): the Review count.
  const reviewCount = useMemo(() => reviewCandidates(garments).length, [garments]);

  const selectedGarment = useMemo(
    () => garments.find((g) => g.id === selectedId) ?? null,
    [garments, selectedId],
  );

  // Sync URL query params for instant live sharing
  useEffect(() => {
    if (typeof window === 'undefined' || !initialPieceResolved) return;
    const url = new URL(window.location.href);
    url.searchParams.set('view', viewMode);
    if (selectedGarment) {
      url.searchParams.set('piece', selectedGarment.code);
    } else {
      url.searchParams.delete('piece');
      url.searchParams.delete('decide');
    }
    window.history.replaceState({}, '', url.toString());
  }, [selectedGarment, viewMode, initialPieceResolved]);

  const railTweenRef = useRef<gsap.core.Tween | null>(null);
  const railProxyRef = useRef<{ offset: number }>({ offset: railOffset });
  railProxyRef.current.offset = railOffset;

  // GSAP-powered quintic ease-out transition synchronizing railOffset with 3D camera panning
  const animateRailOffsetTo = (targetOffset: number) => {
    if (railTweenRef.current) {
      railTweenRef.current.kill();
      railTweenRef.current = null;
    }
    const startOffset = railProxyRef.current.offset;
    if (Math.abs(targetOffset - startOffset) < 0.004) {
      setRailOffset(targetOffset);
      return;
    }

    railTweenRef.current = gsap.to(railProxyRef.current, {
      offset: targetOffset,
      duration: 0.68,
      ease: 'quint.out',
      overwrite: 'auto',
      onUpdate: () => {
        setRailOffset(Number(railProxyRef.current.offset.toFixed(3)));
      },
      onComplete: () => {
        setRailOffset(Number(targetOffset.toFixed(3)));
        railTweenRef.current = null;
      },
    });
  };

  useEffect(() => {
    return () => {
      if (railTweenRef.current) {
        railTweenRef.current.kill();
      }
    };
  }, []);

  // Select a garment and smoothly ease railOffset via GSAP quint.out so the piece glides dead-center in Front Shot mode
  // Esc steps back one layer at a time: close the inspector, then leave the grid (the review mode
  // and the modals handle their own Esc). Typing in a field is never interrupted.
  const accountOpenRef = useRef(accountOpen); accountOpenRef.current = accountOpen;
  const scanOpenRef = useRef(scanOpen); scanOpenRef.current = scanOpen;
  const addModalOpenRef = useRef(addModalOpen); addModalOpenRef.current = addModalOpen;
  const githubShareOpenRef = useRef(githubShareOpen); githubShareOpenRef.current = githubShareOpen;
  const looksOpenRef = useRef(looksOpen); looksOpenRef.current = looksOpen;
  const ledgerOpenRef = useRef(ledgerOpen); ledgerOpenRef.current = ledgerOpen;
  const escRef = useRef({ selectedId, gridView, renderFallback, reviewOpen, modalOpen: false });
  escRef.current = { selectedId, gridView, renderFallback, reviewOpen, modalOpen: accountOpen || ledgerOpen || looksOpen || addModalOpen || githubShareOpen || scanOpen };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (accountOpenRef.current) { e.preventDefault(); e.stopImmediatePropagation(); setAccountOpen(false); return; }
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const cur = escRef.current;
      // Topmost first: a modal, then the inspector, then the mode (the review mode closes itself).
      if (cur.modalOpen) {
        e.stopPropagation();
        if (scanOpenRef.current) setScanOpen(false);
        else if (addModalOpenRef.current) setAddModalOpen(false);
        else if (githubShareOpenRef.current) setGithubShareOpen(false);
        else if (looksOpenRef.current) setLooksOpen(false);
        else if (ledgerOpenRef.current) setLedgerOpen(false);
        return;
      }
      if (cur.selectedId) {
        // Capture phase, so this runs before the rail's and the grid's own Escape listeners; stopping
        // here keeps one keypress from closing two layers (React flushes between listeners).
        e.stopPropagation();
        handleSelectGarmentRef.current(null);
        return;
      }
      if (cur.reviewOpen) return;
      if (cur.gridView && !cur.renderFallback) setGridView(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const handleSelectGarment = (id: string | null) => {
    setInitialPieceResolved(true);
    if (!id) {
      setSelectedId(null);
      animateRailOffsetTo(0);
      return;
    }
    setSelectedId(id);
    const idx = visibleGarments.findIndex((g) => g.id === id);
    if (idx !== -1) {
      const spacing = 0.56;
      const totalWidth = (visibleGarments.length - 1) * spacing;
      const targetBaseX = -totalWidth / 2 + idx * spacing;
      animateRailOffsetTo(targetBaseX);
    }
  };
  const handleSelectGarmentRef = useRef(handleSelectGarment);
  handleSelectGarmentRef.current = handleSelectGarment;

  // Save through the current collection: sample/local state or the signed-in account queue.
  // With no ask price passed (a piece with
  // no price on record), the decision is saved with the latest price seen, else the purchase
  // price, else none (0 = no price at decision).
  const handleSaveDecision = (
    garmentId: string,
    choice: 'keep' | 'sell',
    customAskPrice?: number,
  ) => {
    setGarments((prev) =>
      prev.map((g) => {
        if (g.id !== garmentId) return g;
        const latest = getLatestObservation(g);
        const snapshotPrice =
          typeof customAskPrice === 'number' && customAskPrice > 0
            ? customAskPrice
            : latest?.price ?? g.purchasePrice ?? 0;
        const snapshotPlatform = g.feeConfig.platform;

        // Each explicit save captures a new decision, including changed fee lines.
        // Transport retries are deduplicated by the account save request, not by price.
        const decisionId = `d_${crypto.randomUUID()}`;
        return {
          ...g,
          lastDecision: {
            id: decisionId,
            choice,
            savedAt: new Date().toISOString(),
            feeSnapshot: { ...g.feeConfig },
            snapshotPrice,
            snapshotCurrency: g.currency,
            snapshotPlatform,
          },
        };
      }),
    );
  };

  // Add a new market observation quote to a garment
  const handleAddObservation = (
    garmentId: string,
    platform: ResalePlatform,
    price: number,
    kind: 'traded' | 'listed',
  ) => {
    setGarments((prev) =>
      prev.map((g) => {
        if (g.id !== garmentId) return g;
        return {
          ...g,
          observations: [
            ...g.observations,
            {
              id: `obs-${Date.now()}`,
              date: todayDate(),
              platform,
              price,
              currency: g.currency,
              kind,
            },
          ],
        };
      }),
    );
  };

  // Update fee confirmation: each cost line is ticked separately; the net payout is only
  // computed once BOTH the fee rate and the shipping cost were checked.
  const handleUpdateFeeConfig = (
    garmentId: string,
    feeRateConfirmed: boolean,
    shippingConfirmed: boolean,
  ) => {
    setGarments((prev) =>
      prev.map((g) => {
        if (g.id !== garmentId) return g;
        return {
          ...g,
          feeConfig: {
            ...g.feeConfig,
            feeRateConfirmed,
            shippingConfirmed,
            confirmed: feeLinesConfirmed(feeRateConfirmed, shippingConfirmed),
          },
        };
      }),
    );
  };

  // Toggle Today outfit lock on a single piece
  const handleToggleTodayLock = (garmentId: string) => {
    setGarments((prev) =>
      prev.map((g) =>
        g.id === garmentId ? { ...g, lockedForToday: !g.lockedForToday } : g,
      ),
    );
  };

  // Lock an entire Target Look (e.g., J1 + T1 + B1) for Today
  const handleLockLookForToday = (pieceCodes: string[]) => {
    const codeSet = new Set(pieceCodes);
    setGarments((prev) =>
      prev.map((g) => ({
        ...g,
        lockedForToday: codeSet.has(g.code),
      })),
    );
    setFilterTab('today');
    setRailOffset(0);
  };

  // Take a piece that came from a photo scan off the rail (sample pieces stay)
  const handleRemovePiece = (garmentId: string) => {
    setGarments((prev) => prev.filter((g) => !(g.id === garmentId && (isKeptAfterReload(g) || isPersonalPiece(g)))));
    setSelectedId(null);
  };

  // Image preparation can finish after a view or account switch; keep that result in its original scope.
  const handleHangScanned = async (pieces: GarmentPiece[]) => {
    if (pieces.length === 0) return;
    try {
      // Server receipts bind the original PNG bytes. Already bounded server cutouts
      // must survive the browser unchanged so the server can verify their source.
      const prepared = await Promise.all(pieces.map(piece => piece.scanReceiptId ? piece : preparePiecePhotos(piece)));
      if (controller.getSnapshot().epoch !== renderEpoch) return;
      setGarments(prev => [...prev, ...prepared]);
      setFilterTab('all'); setSelectedId(prepared[0].id);
    } catch (error) {
      if (controller.getSnapshot().epoch === renderEpoch) controller.reportError(error instanceof Error ? error.message : 'Could not prepare the photo.');
    }
  };
  const handleAddGarment = (piece: GarmentPiece) => { void handleHangScanned([piece]); };
  const handleUpdateGarmentPhoto = async (garmentId: string, dataUrl: string) => {
    try {
      const prepared = await preparePhotoUrl(dataUrl);
      if (controller.getSnapshot().epoch !== renderEpoch) return;
      setGarments(prev => prev.map(g => g.id === garmentId ? {
        ...g, imageUrl: prepared, frontImageUrl: prepared, cutoutSource: undefined, scanMode: undefined, scanReceiptId: undefined, scanCardId: undefined, scanColor: undefined,
      } : g));
    } catch (error) {
      if (controller.getSnapshot().epoch === renderEpoch) controller.reportError(error instanceof Error ? error.message : 'Could not prepare the photo.');
    }
  };

  // Next free "A" code for a piece hung from the upload form (never reuses a code on the rail).
  const nextHangIndex = useMemo(() => {
    const used = new Set(garments.map((g) => g.code));
    let n = garments.length + 1;
    while (used.has(`A${n}`)) n += 1;
    return n;
  }, [garments]);

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-white text-[#141413] flex flex-col">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="flex items-center justify-between gap-2 lg:gap-8 px-3 sm:px-6 py-3.5 border-b border-[#E7E2DA] bg-white z-30 shrink-0">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#rail"
          onClick={(e) => {
            e.preventDefault();
            setSelectedId(null);
            setFilterTab('all');
            setRailOffset(0);
            setReviewOpen(false);
          }}
          className="closer-wordmark text-xl font-display font-bold tracking-tight text-[#141413] whitespace-nowrap shrink-0"
        >
          CLOSER
        </a>

        {/* Zone 2: 5 concise single-line text navigation links */}
        <nav
          aria-label="Primary"
          className="hidden xl:flex items-center gap-7 text-sm font-medium text-[#57534E]"
        >
          <a
            href="#rail"
            onClick={(e) => {
              e.preventDefault();
              setViewMode('rail');
              setReviewOpen(false);
            }}
            className={`hover:text-[#141413] transition-colors whitespace-nowrap shrink-0 py-0.5 ${
              viewMode === 'rail'
                ? 'text-[#141413] border-b-2 border-[#F37021]'
                : ''
            }`}
          >
            Boutique Rail
          </a>
          <a
            href="#vault"
            onClick={(e) => {
              e.preventDefault();
              setViewMode('vault');
              setReviewOpen(false);
            }}
            className={`hover:text-[#141413] transition-colors whitespace-nowrap shrink-0 py-0.5 ${
              viewMode === 'vault'
                ? 'text-[#141413] border-b-2 border-[#F37021]'
                : ''
            }`}
          >
            Walk-In Vault
          </a>
          <a
            href="#ledger"
            onClick={(e) => {
              e.preventDefault();
              setLedgerOpen(true);
            }}
            className="hover:text-[#141413] transition-colors whitespace-nowrap shrink-0 py-0.5"
          >
            Asset Ledger
          </a>
          <a
            href="#looks"
            onClick={(e) => {
              e.preventDefault();
              setLooksOpen(true);
            }}
            className="hover:text-[#141413] transition-colors whitespace-nowrap shrink-0 py-0.5"
          >
            Target Looks
          </a>
          <a
            href="#github-share"
            onClick={(e) => {
              e.preventDefault();
              setGithubShareOpen(true);
            }}
            className="hover:text-[#F37021] transition-colors whitespace-nowrap shrink-0 py-0.5"
          >
            GitHub &amp; Share
          </a>
        </nav>

        {/* Zone 3: 1 primary action in Hermès Orange */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            data-testid="top-upload-photo-btn"
            onClick={() => setAddModalOpen(true)}
            className="px-4 py-2 text-xs font-semibold text-white bg-[#F37021] rounded-lg hover:bg-[#D95D12] transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Upload Photo &amp; Hang</span><span className="sm:hidden">Add photo</span>
          </button>
          <button type="button" aria-label={wardrobe.account ? `Account: ${wardrobe.account.handle}` : 'Account · sign in'} onClick={() => { setInitialPieceResolved(true); setAccountOpen(true); }} className="min-h-11 min-w-11 inline-flex items-center justify-center gap-1.5 rounded-lg border border-[#E7E2DA] px-2 text-xs font-medium" title={wardrobe.persistenceNotice}>
            <UserRound size={17} /><span className="hidden sm:inline">{wardrobe.account ? 'Account' : 'Sign in'}</span>
          </button>
        </div>
      </header>

      {/* Main Unobstructed 3D Boutique Viewport */}
      <main className="relative flex-1 w-full overflow-hidden">
        {wardrobe.error && <div role="alert" className="absolute bottom-5 left-1/2 -translate-x-1/2 z-[60] max-w-[calc(100vw-2rem)] rounded-lg border border-orange-200 bg-white px-3 py-2 text-xs shadow-lg">
          <span>{wardrobe.error}</span> <button type="button" onClick={() => setAccountOpen(true)} className="font-semibold text-[#9A3412] underline min-h-9 px-2">Account &amp; save</button>
        </div>}
        {!selectedId && !gridView && !reviewOpen && <MarketPulse garments={garments} onSelect={handleSelectGarment} demo={wardrobe.sampleView} />}

        {/* Top-Left Minimal Boutique Asset Ledger Plaque (Non-occluding) */}
        <div
          className="absolute top-5 left-6 z-20 bg-white/95 border border-[#E7E2DA] rounded-xl px-4 py-3 shadow-sm max-w-[calc(100vw-3rem)] sm:max-w-[25rem]"
          data-testid="asset-ledger-plaque"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] font-medium text-[#8C857B] tracking-wide shrink-0">
              {privateView ? 'YOUR CLOSET AT A GLANCE' : mixedGuestView ? 'BROWSER CLOSET AT A GLANCE' : 'SAMPLE CLOSET AT A GLANCE'}
            </span>
            <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-0.5">
              <button
                type="button"
                onClick={() => setGithubShareOpen(true)}
                className="text-[11px] font-medium text-[#57534E] hover:text-[#141413] inline-flex items-center gap-1 whitespace-nowrap"
                title="Share link · GitHub command (copy only)"
              >
                <Share2 className="w-3 h-3 text-[#F37021]" />
                <span>Share</span>
              </button>
              <button
                type="button"
                onClick={() => setLedgerOpen(true)}
                className="text-[11px] font-semibold text-[#F37021] hover:underline whitespace-nowrap"
              >
                Full Ledger
              </button>
              <button
                type="button"
                data-testid="plaque-review-link"
                onClick={() => setReviewOpen(true)}
                className="text-[11px] font-semibold text-[#F37021] hover:underline whitespace-nowrap"
                title="Compare the pieces marked Sell and the undecided ones"
              >
                Review {reviewCount}
              </button>
            </div>
          </div>

          <div
            className="text-[10px] text-[#57534E] mt-0.5"
            data-testid="sample-data-notice"
          >
            {privateView ? wardrobe.persistenceNotice : mixedGuestView ? 'Sample closet + your local pieces · latest price seen · nothing is posted' : 'Sample data · latest price seen · nothing is listed, posted or paid'}
          </div>

          <div className="flex items-baseline gap-3 mt-1">
            <div>
              <div className="text-lg font-mono-num font-semibold text-[#141413]">
                {formatCurrency(ledgerSummary.krw.ownedTotalLatest, 'KRW')}
              </div>
              <div className="text-[10px] text-[#57534E]">
                {ledgerSummary.krw.ownedSeenCount} of{' '}
                {ledgerSummary.krw.ownedTotalPieces} KRW pieces
              </div>
            </div>

            <span className="text-[#E7E2DA]" aria-hidden="true">
              /
            </span>

            <div>
              <div className="text-lg font-mono-num font-semibold text-[#141413]">
                {formatCurrency(ledgerSummary.usd.ownedTotalLatest, 'USD')}
              </div>
              <div className="text-[10px] text-[#57534E]">
                {ledgerSummary.usd.ownedSeenCount} of{' '}
                {ledgerSummary.usd.ownedTotalPieces} USD pieces
              </div>
            </div>
          </div>

          <div className="text-[10px] text-[#8C857B] mt-2 pt-1.5 border-t border-[#E7E2DA] flex flex-wrap sm:flex-nowrap items-center justify-between gap-x-2">
            <span className="whitespace-nowrap">
              Sample {formatCurrency(ledgerSummary.krw.sampleTotalLatest, 'KRW')}{' '}
              apart
            </span>
            <span aria-hidden="true">·</span>
            <span
              className="text-[#141413] font-medium whitespace-nowrap"
              data-testid="decision-counts"
            >
              {ledgerSummary.keepCount} Keep · {ledgerSummary.sellCount} Sell ·{' '}
              {ledgerSummary.undecidedCount} undecided (of{' '}
              {ledgerSummary.totalOwnedPieces})
            </span>
          </div>
        </div>

        {/* Center-Top Subtle Editorial Header OR Active Front-Shot Indicator */}
        {selectedGarment ? (
          <div
            className=" hidden lg:flex absolute top-5 z-20 items-center gap-3 px-4 py-2 rounded-xl bg-white/95 border border-[#F37021] shadow-md -translate-x-1/2"
            style={{
              left: 'calc(50% - 60px)',
            }}
            data-testid="active-front-shot-banner"
          >
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#F37021]">
              <Eye className="w-3.5 h-3.5" />
              <span>FRONT SHOT</span>
            </span>
            <span className="text-xs font-mono-num font-bold text-[#141413]">
              {[selectedGarment.code, selectedGarment.brand]
                .filter(Boolean)
                .join(' · ')}
            </span>
            <button
              type="button"
              onClick={() => handleSelectGarment(null)}
              className="ml-1 px-2.5 py-1 rounded-md bg-[#FAF8F5] hover:bg-[#FFF3EB] border border-[#E7E2DA] text-[11px] font-medium text-[#141413] inline-flex items-center gap-1 transition-colors whitespace-nowrap"
            >
              <RotateCcw className="w-3 h-3 text-[#F37021]" />
              <span>Full 3D Rail</span>
            </button>
          </div>
        ) : (
          <div className="pointer-events-none absolute top-6 left-1/2 -translate-x-1/2 z-10 hidden lg:flex flex-col items-center text-center">
            <div className="flex items-center gap-2.5 text-xs tracking-[0.18em] text-[#141413] font-semibold">
              <span>ARCHIVE COLLECTION</span>
              <span className="text-[#C5A572]" aria-hidden="true">
                |
              </span>
              <span className="text-[#8C857B] font-normal">
                HUNG LIKE A BOUTIQUE RAIL
              </span>
            </div>
          </div>
        )}

        {/* 3D WebGL Boutique Rail / Walk-In Vault Scene */}
        {gridView && renderFallback && (
          <div
            data-testid="render-fallback-note"
            className="absolute left-6 right-6 sm:right-auto top-40 z-20 flex flex-wrap items-center gap-x-3 gap-y-1 bg-white/95 border border-[#E7E2DA] rounded-xl px-3 py-1.5 shadow-sm text-[11px] text-[#141413]"
          >
            <span>3D view unavailable: {renderFallback}. Showing the grid.</span>
            <button
              type="button"
              data-testid="try-3d-again"
              onClick={() => setGridView(false)}
              className="px-2.5 py-1 rounded-md bg-[#FAF8F5] hover:bg-[#FFF3EB] border border-[#E7E2DA] text-[11px] font-medium text-[#141413] inline-flex items-center gap-1 transition-colors whitespace-nowrap"
            >
              <RotateCcw className="w-3 h-3 text-[#F37021]" />
              <span>Try 3D again</span>
            </button>
          </div>
        )}
        {visibleGarments.length === 0 ? (
          <EmptyStage filtered={garments.length > 0} onClearFilter={() => setFilterTab('all')} onStart={() => setAddModalOpen(true)} />
        ) : gridView ? (
          <ClosetGrid garments={visibleGarments} selectedId={selectedId} onSelect={(id) => handleSelectGarment(id)} />
        ) : (
          <React.Suspense fallback={<div className="absolute inset-0 flex items-center justify-center text-xs text-[#8C857B]">Hanging the rail…</div>}>
            <BoutiqueRail3D
                key={`scene-${wardrobe.epoch}`}
              garments={visibleGarments}
              selectedId={selectedId}
              onSelectGarment={handleSelectGarment}
              viewMode={viewMode}
                onViewModeChange={setViewMode}
              railOffset={railOffset}
              onRailOffsetChange={setRailOffset}
              showHangTags={showHangTags}
              showRotationHeatmap={showRotationHeatmap}
              onRenderFallback={(reason) => { setRenderFallback(reason); setGridView(true); }}
            />
          </React.Suspense>
        )}
        {!gridView && !reviewOpen && visibleGarments.length > 0 && (
          <SpaceCallout scannedCount={garments.filter((g) => g.cutoutSource).length} onStart={() => setScanOpen(true)} />
        )}

        {/* Unified Collapsible Bottom Control Dock (Zero Viewport Occlusion) */}
        <div
          data-testid="rail-control-dock"
          style={{
            bottom: '20px',
            left: selectedGarment ? 'calc(50% - 230px)' : '50%',
            transform: 'translateX(-50%)',
            maxWidth: selectedGarment
              ? 'min(820px, calc(100vw - 490px))'
              : 'min(920px, 94vw)',
          }}
          className="fixed z-20 w-full flex flex-col items-center pointer-events-none transition-all duration-200"
        >
          {/* Collapse / Expand Toggle Tab */}
          <button
            type="button"
            onClick={() => setDockCollapsed((c) => !c)}
            className="pointer-events-auto mb-1.5 px-3.5 py-1 rounded-full bg-white border border-[#E7E2DA] shadow-sm text-[11px] font-medium text-[#57534E] hover:text-[#141413] flex items-center gap-1 transition-colors whitespace-nowrap"
          >
            {dockCollapsed ? (
              <>
                <ChevronUp className="w-3.5 h-3.5 text-[#F37021]" />
                <span>Show Rail Controls</span>
              </>
            ) : (
              <>
                <ChevronDown className="w-3.5 h-3.5 text-[#F37021]" />
                <span>Hide Controls</span>
              </>
            )}
          </button>

          {!dockCollapsed && (
            <div className="pointer-events-auto w-full bg-white border border-[#E7E2DA] rounded-2xl shadow-lg px-4 py-3 flex flex-col gap-2.5">
              {/* Top Row inside Dock: Garment Quick-Select Hanger Carousel */}
              <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
                {visibleGarments.map((g) => {
                  const isSel = selectedId === g.id;
                  const latest = getLatestObservation(g);
                  return (
                    <button
                      key={g.id}
                      type="button"
                      onClick={() =>
                        handleSelectGarment(isSel ? null : g.id)
                      }
                      className={`px-2.5 py-1.5 rounded-lg border text-left transition-colors shrink-0 flex items-center gap-2 ${
                        isSel
                          ? 'bg-[#FFF3EB] border-[#F37021] text-[#141413]'
                          : 'bg-[#FAF8F5] border-[#E7E2DA] text-[#57534E] hover:text-[#141413] hover:border-[#C5A572]'
                      }`}
                    >
                      <span
                        className="w-2.5 h-2.5 rounded-full shrink-0 border border-black/15"
                        style={{ backgroundColor: g.colorHex }}
                      />
                      <span className="text-xs font-mono-num font-semibold text-[#141413]">
                        {g.code}
                      </span>
                      {g.isSample && (
                        <span className="text-[10px] font-semibold text-[#F37021]">
                          · Sample ·
                        </span>
                      )}
                      <span className="text-[11px] truncate max-w-[96px]">
                        {g.brand}
                      </span>
                      <span className="text-[11px] font-mono-num text-[#8C857B]">
                        {latest ? formatCurrency(latest.price, g.currency) : ''}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Bottom Row inside Dock: Filter Tabs + 3D View & Hang-Tag Toggles */}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-1.5 border-t border-[#E7E2DA]">
                {/* Filter Segmented Bar */}
                <div
                  className="flex items-center gap-1 bg-[#FAF8F5] p-1 rounded-lg border border-[#E7E2DA]"
                  role="group"
                  aria-label="Filter boutique rail"
                >
                  {(
                    [
                      { id: 'all', label: `All (${garments.length})` },
                      { id: 'KRW', label: 'KRW ₩' },
                      { id: 'USD', label: 'USD $' },
                      { id: 'sell', label: `Sell (${ledgerSummary.sellCount})` },
                      { id: 'today', label: 'Today Lock' },
                    ] as const
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => {
                        setFilterTab(tab.id);
                        setRailOffset(0);
                      }}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                        filterTab === tab.id
                          ? 'bg-[#141413] text-white'
                          : 'text-[#57534E] hover:text-[#141413]'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                {/* Rail Scrubber & 3D Architecture Controls */}
                <div className="flex items-center gap-2.5">
                  <div className="hidden sm:flex items-center gap-2 text-xs text-[#57534E]">
                    <SlidersHorizontal className="w-3.5 h-3.5 text-[#F37021]" />
                    <input
                      type="range"
                      aria-label="Slide along boutique rail"
                      min={-3.2}
                      max={3.2}
                      step={0.05}
                      value={railOffset}
                      onChange={(e) => setRailOffset(Number(e.target.value))}
                      className="w-24 accent-[#F37021] cursor-pointer"
                    />
                  </div>

                  <button
                    type="button"
                    data-testid="rotation-heatmap-toggle"
                    onClick={() => setShowRotationHeatmap((v) => !v)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
                      showRotationHeatmap
                        ? 'bg-[#EFF6FF] text-[#1E3A8A] border-[#60A5FA]'
                        : 'bg-white text-[#57534E] border-[#E7E2DA]'
                    }`}
                  >
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{
                        background:
                          'linear-gradient(90deg, #3B82F6 0%, #F37021 100%)',
                      }}
                    />
                    <span>
                      Rotation Heatmap: {showRotationHeatmap ? 'ON' : 'OFF'}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setShowHangTags((v) => !v)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                      showHangTags
                        ? 'bg-[#FFF3EB] text-[#F37021] border-[#F37021]'
                        : 'bg-white text-[#57534E] border-[#E7E2DA]'
                    }`}
                  >
                    Asset Tags: {showHangTags ? 'ON' : 'OFF'}
                  </button>

                  <div
                    className="flex items-center bg-[#FAF8F5] p-0.5 rounded-lg border border-[#E7E2DA]"
                    role="group"
                    aria-label="3D Environment Mode"
                  >
                    <button
                      type="button"
                      onClick={() => { setGridView(false); setViewMode('rail'); }}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                        !gridView && viewMode === 'rail'
                          ? 'bg-[#F37021] text-white'
                          : 'text-[#57534E] hover:text-[#141413]'
                      }`}
                    >
                      3D Rail
                    </button>
                    <button
                      type="button"
                      onClick={() => { setGridView(false); setViewMode('vault'); }}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                        !gridView && viewMode === 'vault'
                          ? 'bg-[#F37021] text-white'
                          : 'text-[#57534E] hover:text-[#141413]'
                      }`}
                    >
                      Walk-In Vault
                    </button>
                    <button
                      type="button"
                      data-testid="view-grid"
                      onClick={() => setGridView(true)}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                        gridView ? 'bg-[#F37021] text-white' : 'text-[#57534E] hover:text-[#141413]'
                      }`}
                    >
                      Grid
                    </button>
                    <button
                      type="button"
                      data-testid="view-review"
                      onClick={() => setReviewOpen(true)}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                        reviewOpen ? 'bg-[#F37021] text-white' : 'text-[#57534E] hover:text-[#141413]'
                      }`}
                    >
                      Review
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Slide-Over Garment Inspection & Keep-or-Sell counted-records board */}
        <GarmentInspectDrawer
          key={`inspector-${wardrobe.epoch}`}
          persistenceNotice={privateView ? wardrobe.persistenceNotice : wardrobe.sampleView || !selectedGarment || !isPersonalPiece(selectedGarment) ? 'Sample closet · changes reset on reload' : wardrobe.error ? 'Check the save message before leaving this page' : 'Saved in this browser · sign in for account storage'}
          garment={selectedGarment}
          looks={activeLooks}
          onClose={() => handleSelectGarment(null)}
          onSaveDecision={handleSaveDecision}
          onAddObservation={handleAddObservation}
          onUpdateFeeConfig={handleUpdateFeeConfig}
          onToggleTodayLock={handleToggleTodayLock}
          onLockLookForToday={handleLockLookForToday}
          onOpenSnapUpload={() => setAddModalOpen(true)}
          onUpdateGarmentPhoto={handleUpdateGarmentPhoto}
          onRemovePiece={handleRemovePiece}
        />

        {/* Review work mode: Sell + undecided pieces side by side, over the space (Esc or Close leaves it) */}
        {reviewOpen && (
          <ReviewMode
            garments={garments}
            sharedSelectedId={selectedId}
            onOpenInspector={(id) => {
              setReviewOpen(false);
              // A piece hidden by the filter would open in the drawer but not on the rail.
              if (!visibleGarments.some((g) => g.id === id)) setFilterTab('all');
              handleSelectGarment(id);
            }}
            onClose={() => setReviewOpen(false)}
          />
        )}
      </main>

      <ScanPhotoModal key={`scan-${wardrobe.epoch}`} isOpen={scanOpen} onClose={() => setScanOpen(false)} garments={garments} onHang={handleHangScanned} workspaceId={privateView ? wardrobe.account?.workspaceId : null} />

      {/* Modals for Full Asset Ledger, Target Looks, Hang New Piece, and Share link / GitHub command (copy only) */}
      <LedgerModal
        isOpen={ledgerOpen}
        scope={privateView ? 'account' : wardrobe.sampleView ? 'sample' : 'browser'}
        accountState={wardrobe}
        onClose={() => setLedgerOpen(false)}
        garments={garments}
        summary={ledgerSummary}
        onSelectGarment={handleSelectGarment}
      />

      <LooksModal
        isOpen={looksOpen}
        onClose={() => setLooksOpen(false)}
        looks={activeLooks}
        garments={garments}
        onLockLookForToday={handleLockLookForToday}
      />

      <AddGarmentModal
        key={`add-${wardrobe.epoch}`}
        isOpen={addModalOpen}
        onClose={() => setAddModalOpen(false)}
        onAddGarment={handleAddGarment}
        onScanCloset={() => { setAddModalOpen(false); setScanOpen(true); }}
        nextIndex={nextHangIndex}
        workspaceId={privateView ? wardrobe.account?.workspaceId : null}
      />

      <AccountPanel isOpen={accountOpen} onClose={() => setAccountOpen(false)} state={wardrobe} controller={controller} persistenceNotice={wardrobe.persistenceNotice} />

      <GitHubShareModal
        isOpen={githubShareOpen}
        onClose={() => setGithubShareOpen(false)}
        garments={garments}
        selectedPieceCode={selectedGarment?.code ?? null}
        viewMode={viewMode}
      />
    </div>
  );
}
