import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, Copy, Eye, X } from 'lucide-react';
import { GarmentPiece } from '../types/closet';
import {
  describePhotoSource,
  formatCurrency,
  isKeptAfterReload,
} from '../utils/ledgerLogic';
import { KalshiPriceChart } from './KalshiPriceChart';
import {
  buildListingDraft,
  describeLatestPrice,
  describeSumLine,
  describeWears,
  reviewCandidates,
  reviewSums,
  tradedBand,
  ReviewRow,
} from '../utils/review';

// Review: the work mode for comparing several pieces. Candidates are the pieces marked Sell plus
// the undecided ones, in review order (Sell first, then the fewest counted wears; no wear log
// last). Wide screens: the list on the left, the picked piece's recorded prices and its net at the
// latest price seen on the right, per-currency sums at the bottom. Phone: the list first; a row
// opens its detail over the list (scroll and selection kept) and Back returns. Every number is
// counted from the same records the rail and the inspector show; nothing is estimated or ranked
// by anything but the owner's decision and the counted wears. Copy is copy: nothing is posted.

const DESKTOP_QUERY = '(min-width: 1024px)';
const isDesktop = () =>
  typeof window !== 'undefined' && window.matchMedia(DESKTOP_QUERY).matches;

interface ReviewModeProps {
  garments: GarmentPiece[];
  /** The selection shared with the rail, vault and grid; the first candidate when it is not one. */
  sharedSelectedId: string | null;
  /** Hands the piece to the inspector (the existing selection handler) and leaves the mode. */
  onOpenInspector: (garmentId: string) => void;
  onClose: () => void;
}

const CHIP = 'text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap';

function DecisionChips({ row }: { row: ReviewRow }) {
  return (
    <>
      {row.isSample && (
        <span className={`${CHIP} border border-dashed border-[#B8B2A7] text-[#57534E]`}>
          Sample
        </span>
      )}
      {row.decision === 'sell' ? (
        <span className={`${CHIP} border border-[#B8460F] text-[#B8460F]`}>Sell</span>
      ) : (
        <span className={`${CHIP} text-[#8C857B]`}>Undecided</span>
      )}
    </>
  );
}

function KindBadge({ kind }: { kind: 'traded' | 'listed' }) {
  return kind === 'traded' ? (
    <span className={`${CHIP} bg-[#F37021] text-white`}>trade</span>
  ) : (
    <span className={`${CHIP} border border-[#141413] text-[#141413]`}>ask</span>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-28 shrink-0 text-[#8C857B]">{label}</dt>
      <dd className="text-[#141413] min-w-0">{value}</dd>
    </div>
  );
}

function MoneyLine({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div
      className={`flex items-baseline justify-between gap-3 ${
        strong ? 'font-semibold border-t border-[#E7E2DA] pt-1 mt-1' : ''
      }`}
    >
      <dt className={strong ? 'text-[#141413]' : 'text-[#57534E]'}>{label}</dt>
      <dd className="text-[#141413]">{value}</dd>
    </div>
  );
}

interface DetailProps {
  row: ReviewRow;
  included: boolean;
  chartWindow: '30d' | '90d' | 'all';
  copied: 'idle' | 'copied' | 'failed';
  onWindowChange: (w: '30d' | '90d' | 'all') => void;
  onToggleInclude: (id: string) => void;
  onBack: () => void;
  onOpenInspector: (id: string) => void;
  onCopyDraft: () => void;
}

function Detail({
  row,
  included,
  chartWindow,
  copied,
  onWindowChange,
  onToggleInclude,
  onBack,
  onOpenInspector,
  onCopyDraft,
}: DetailProps) {
  const g = row.garment;
  const img = g.frontImageUrl || g.imageUrl;
  const band = tradedBand(g);
  const net = row.netInfo;
  const fee = g.feeConfig;
  const notTicked = [
    fee.feeRateConfirmed !== true ? 'fee rate' : null,
    fee.shippingConfirmed !== true ? 'shipping' : null,
  ].filter((x): x is string => x !== null);
  const latestText = describeLatestPrice(row);
  const storageNote = isKeptAfterReload(g)
    ? 'Saved in this browser only · kept after reload'
    : 'Saved in this browser only · resets on reload';

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-3xl" data-piece-code={row.code}>
      <button
        type="button"
        data-testid="review-back"
        onClick={onBack}
        className="lg:hidden inline-flex items-center gap-1 text-xs font-medium text-[#57534E] hover:text-[#141413]"
      >
        <ArrowLeft className="w-3.5 h-3.5 text-[#F37021]" />
        <span>Back to the list</span>
      </button>

      <div className="flex gap-4 items-start">
        <div className="w-24 h-32 rounded-lg bg-[#FAF8F5] border border-[#E7E2DA] flex items-center justify-center overflow-hidden shrink-0">
          {img ? (
            <img
              src={img}
              alt={g.name || g.code}
              className="max-w-full max-h-full object-contain"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          ) : (
            <span className="w-10 h-10 rounded-full" style={{ background: g.colorHex }} aria-hidden="true" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-mono-num text-sm font-bold text-[#141413]">{row.code}</span>
            <DecisionChips row={row} />
          </div>
          <div className="text-lg font-display font-bold text-[#141413] leading-tight mt-1">
            {g.brand ? `${g.brand} · ` : ''}
            {g.name || 'Name not entered'}
          </div>
          <dl className="mt-2.5 text-xs space-y-1">
            <Fact label="Wear record" value={describeWears(row)} />
            <Fact label="Latest price seen" value={latestText} />
            <Fact
              label="Paid"
              value={g.purchasePrice ? formatCurrency(g.purchasePrice, g.currency) : 'not entered'}
            />
            <Fact
              label="Decision"
              value={
                row.decision === 'sell'
                  ? `Sell · saved ${g.lastDecision?.savedAt ?? 'date unknown'}`
                  : 'Undecided'
              }
            />
            <Fact label="Photo" value={describePhotoSource(g)} />
          </dl>
        </div>
      </div>

      {/* The same per-platform chart as the inspector. No ask is set here: the review reads prices seen. */}
      <KalshiPriceChart
        garment={g}
        observations={g.observations}
        currency={g.currency}
        window={chartWindow}
        onWindowChange={onWindowChange}
        purchasePrice={g.purchasePrice}
        simulatedAskPrice={null}
        tradedBandMin={band.min}
        tradedBandMax={band.max}
        tradedCount={band.count}
      />

      {/* Net at the latest price seen: only with a price on record, and a number only once every cost line is ticked. */}
      {row.latest && net && (
        <div
          data-testid="review-net"
          data-net-status={net.status}
          className="border border-[#E7E2DA] rounded-xl bg-[#FAF8F5] p-4 space-y-1.5"
        >
          <div className="text-[11px] font-medium text-[#8C857B] tracking-wide">
            NET IF SOLD AT THE LATEST PRICE SEEN · {fee.platform}
          </div>
          {net.status === 'confirmed' && net.netPayout !== null ? (
            <>
              <dl className="text-xs font-mono-num space-y-1">
                <MoneyLine
                  label="Latest price seen"
                  value={formatCurrency(net.gross ?? row.latest.price, g.currency)}
                />
                <MoneyLine
                  label={`Platform fee ${fee.feeRatePct}%`}
                  value={`−${formatCurrency(net.feeAmount ?? 0, g.currency)}`}
                />
                <MoneyLine label="Shipping" value={`−${formatCurrency(net.shipping ?? 0, g.currency)}`} />
                <MoneyLine label="Net" value={formatCurrency(net.netPayout, g.currency)} strong />
              </dl>
              <div className="text-[10px] text-[#8C857B]">
                Fee rate and shipping ticked by you ·{' '}
                {row.isSample ? 'Sample · not summed' : included ? 'in the sum below' : 'not in the sum below'}
              </div>
            </>
          ) : (
            <>
              <div className="text-sm font-semibold text-[#141413]">Fee not confirmed</div>
              <div className="text-[11px] text-[#57534E]">
                {notTicked.length > 0
                  ? `Not ticked: ${notTicked.join(' · ')} (${fee.platform} ${fee.feeRatePct}% · shipping ${formatCurrency(
                      fee.shippingCost,
                      g.currency,
                    )}). `
                  : 'The fee lines on record cannot be used. '}
                Tick the cost lines in the inspector to see a net.
              </div>
            </>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="review-open-inspector"
          onClick={() => onOpenInspector(row.id)}
          className="px-3.5 py-2 text-xs font-semibold text-white bg-[#F37021] rounded-lg hover:bg-[#D95D12] transition-colors inline-flex items-center gap-1.5 whitespace-nowrap"
        >
          <Eye className="w-3.5 h-3.5" />
          <span>Open in inspector</span>
        </button>
        <button
          type="button"
          data-testid="review-copy-draft"
          onClick={onCopyDraft}
          className="px-3.5 py-2 text-xs font-medium text-[#141413] bg-white border border-[#E7E2DA] rounded-lg hover:border-[#C5A572] transition-colors inline-flex items-center gap-1.5 whitespace-nowrap"
        >
          {copied === 'copied' ? (
            <>
              <Check className="w-3.5 h-3.5 text-[#F37021]" />
              <span>Draft copied</span>
            </>
          ) : copied === 'failed' ? (
            <span>Copy failed · select the text in the inspector</span>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5 text-[#F37021]" />
              <span>Copy listing draft</span>
            </>
          )}
        </button>
        {!row.isSample && (
          <label className="inline-flex items-center gap-1.5 text-xs text-[#57534E] cursor-pointer sm:ml-auto">
            <input
              type="checkbox"
              data-testid="review-detail-include"
              checked={included}
              onChange={() => onToggleInclude(row.id)}
              className="w-3.5 h-3.5 accent-[#F37021] cursor-pointer"
            />
            <span>In the sum</span>
          </label>
        )}
      </div>
      <div className="text-[10px] text-[#8C857B]">
        Copy only · nothing is listed, posted or paid · decision {storageNote.toLowerCase()}
      </div>
    </div>
  );
}

export const ReviewMode: React.FC<ReviewModeProps> = ({
  garments,
  sharedSelectedId,
  onOpenInspector,
  onClose,
}) => {
  const rows = useMemo(() => reviewCandidates(garments), [garments]);
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const first = reviewCandidates(garments);
    return first.some((r) => r.id === sharedSelectedId) ? sharedSelectedId : (first[0]?.id ?? null);
  });
  // Rows ticked into the bottom sum. The owner's own Sell decisions start ticked; the rest is a tap.
  const [included, setIncluded] = useState<Set<string>>(
    () =>
      new Set(
        reviewCandidates(garments)
          .filter((r) => r.decision === 'sell' && !r.isSample)
          .map((r) => r.id),
      ),
  );
  const [chartWindow, setChartWindow] = useState<'30d' | '90d' | 'all'>('all');
  const [phoneDetailOpen, setPhoneDetailOpen] = useState<boolean>(false);
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const sectionRef = useRef<HTMLElement | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    sectionRef.current?.focus();
    return () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  // Keep a valid selection when the candidate list changes under the mode.
  useEffect(() => {
    if (rows.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!rows.some((r) => r.id === selectedId)) setSelectedId(rows[0].id);
  }, [rows, selectedId]);

  const selectedRow = useMemo(
    () => rows.find((r) => r.id === selectedId) ?? null,
    [rows, selectedId],
  );
  const sums = useMemo(() => reviewSums(rows, included), [rows, included]);
  const sumLines = [sums.krw, sums.usd].filter((b) => b.selected > 0);

  // Esc steps one layer at a time: the phone detail first, then the mode itself.
  const latestRef = useRef({ phoneDetailOpen, onClose });
  latestRef.current = { phoneDetailOpen, onClose };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (latestRef.current.phoneDetailOpen && !isDesktop()) {
        setPhoneDetailOpen(false);
        return;
      }
      latestRef.current.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const selectRow = (id: string) => {
    setSelectedId(id);
    setCopied('idle');
    setPhoneDetailOpen(true);
  };

  const toggleInclude = (id: string) => {
    setIncluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // "Copied" only after the browser confirms the clipboard write. Copy only; nothing is posted.
  const handleCopyDraft = async () => {
    if (!selectedRow) return;
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(buildListingDraft(selectedRow.garment));
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopied('idle'), 2200);
  };

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      role="region"
      aria-label="Review"
      data-testid="review-mode"
      data-candidates={rows.length}
      data-phone-detail={phoneDetailOpen ? 'open' : 'closed'}
      className="absolute inset-0 z-[35] bg-white text-[#141413] flex flex-col outline-none"
    >
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3 px-4 sm:px-6 py-3 border-b border-[#E7E2DA] shrink-0">
        <div className="min-w-0">
          <div className="text-[11px] font-medium text-[#8C857B] tracking-wide">
            REVIEW · SELL AND UNDECIDED PIECES
          </div>
          <div className="text-sm font-semibold text-[#141413] truncate" data-testid="review-count">
            {rows.length} {rows.length === 1 ? 'candidate' : 'candidates'} · Sell first, then the
            fewest wears in 60 days
          </div>
        </div>
        <button
          type="button"
          data-testid="review-close"
          onClick={onClose}
          className="shrink-0 px-2.5 py-1 rounded-md bg-[#FAF8F5] hover:bg-[#FFF3EB] border border-[#E7E2DA] text-[11px] font-medium text-[#141413] inline-flex items-center gap-1 transition-colors whitespace-nowrap"
        >
          <X className="w-3 h-3 text-[#F37021]" />
          <span>Close</span>
        </button>
      </div>

      {rows.length === 0 ? (
        <div
          className="flex-1 flex items-center justify-center text-sm text-[#57534E] px-6 text-center"
          data-testid="review-empty"
        >
          No pieces to review · every piece is marked Keep
        </div>
      ) : (
        <div className="relative flex-1 min-h-0 flex overflow-hidden">
          {/* Candidate list (stays mounted on a phone, so its scroll survives the detail) */}
          <div
            className="w-full lg:w-[440px] xl:w-[480px] shrink-0 overflow-y-auto lg:border-r border-[#E7E2DA]"
            data-testid="review-list"
          >
            {rows.map((row) => {
              const isSel = row.id === selectedId;
              const isIn = included.has(row.id);
              const g = row.garment;
              return (
                <div
                  key={row.id}
                  data-testid="review-row"
                  data-piece-code={row.code}
                  data-decision={row.decision}
                  data-sample={row.isSample ? '1' : '0'}
                  data-included={isIn ? '1' : '0'}
                  data-selected={isSel ? '1' : '0'}
                  className={`flex items-stretch border-b border-[#E7E2DA] transition-colors ${
                    isSel ? 'bg-[#FFF3EB]' : 'bg-white hover:bg-[#FAF8F5]'
                  }`}
                >
                  <label
                    className="flex items-center pl-4 pr-2 shrink-0 cursor-pointer"
                    title={row.isSample ? 'Sample · not summed' : isIn ? 'In the sum' : 'Not in the sum'}
                  >
                    <input
                      type="checkbox"
                      data-testid="review-include"
                      aria-label={
                        row.isSample ? `${row.code} · Sample · not summed` : `Include ${row.code} in the sum`
                      }
                      checked={isIn}
                      disabled={row.isSample}
                      onChange={() => toggleInclude(row.id)}
                      className="w-3.5 h-3.5 accent-[#F37021] cursor-pointer disabled:cursor-not-allowed"
                    />
                  </label>
                  <button
                    type="button"
                    data-testid="review-row-select"
                    aria-pressed={isSel}
                    onClick={() => selectRow(row.id)}
                    className="flex-1 min-w-0 text-left py-2.5 pr-4 flex items-center gap-3"
                  >
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0 border border-black/15"
                      style={{ backgroundColor: g.colorHex }}
                      aria-hidden="true"
                    />
                    <span className="flex-1 min-w-0">
                      <span className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-mono-num text-[11px] font-semibold text-[#141413]">
                          {row.code}
                        </span>
                        <DecisionChips row={row} />
                      </span>
                      <span className="block text-xs text-[#141413] leading-snug truncate">
                        {g.brand ? <span className="font-semibold">{g.brand} </span> : null}
                        {g.name || 'Name not entered'}
                      </span>
                      <span
                        className="block text-[10px] text-[#57534E] truncate"
                        data-testid="review-row-wears"
                      >
                        {describeWears(row)}
                      </span>
                    </span>
                    <span className="shrink-0 text-right" data-testid="review-row-price">
                      {row.latest ? (
                        <>
                          <span className="block text-[11px] font-mono-num font-semibold text-[#141413]">
                            {formatCurrency(row.latest.price, row.latest.currency)}
                          </span>
                          <span className="flex items-center justify-end gap-1 text-[10px] text-[#8C857B] mt-0.5">
                            <span className="whitespace-nowrap">
                              {row.latest.platform}
                              {row.latest.isSample ? ' · Sample' : ''}
                            </span>
                            <KindBadge kind={row.latest.kind} />
                          </span>
                        </>
                      ) : (
                        <span className="inline-block text-[10px] px-1.5 py-0.5 rounded border border-dashed border-[#B8B2A7] text-[#57534E] whitespace-nowrap">
                          No price seen
                        </span>
                      )}
                      {row.isSample ? (
                        <span className="block text-[10px] text-[#8C857B] mt-0.5 whitespace-nowrap">
                          Sample · not summed
                        </span>
                      ) : row.latest && !row.feesChecked ? (
                        <span className="block text-[10px] text-[#8C857B] mt-0.5 whitespace-nowrap">
                          Fee not confirmed
                        </span>
                      ) : null}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>

          {/* Detail: a column on wide screens, a panel over the list on a phone */}
          <div
            data-testid="review-detail"
            className={`absolute inset-0 lg:static lg:flex-1 lg:min-w-0 bg-white overflow-y-auto transition-transform duration-200 ${
              phoneDetailOpen ? 'translate-x-0 visible' : 'translate-x-full invisible'
            } lg:translate-x-0 lg:visible`}
          >
            {selectedRow && (
              <Detail
                row={selectedRow}
                included={included.has(selectedRow.id)}
                chartWindow={chartWindow}
                copied={copied}
                onWindowChange={setChartWindow}
                onToggleInclude={toggleInclude}
                onBack={() => setPhoneDetailOpen(false)}
                onOpenInspector={onOpenInspector}
                onCopyDraft={handleCopyDraft}
              />
            )}
          </div>
        </div>
      )}

      {/* Bottom bar: one line per currency with a ticked row. KRW and USD are never added together. */}
      <div
        data-testid="review-sum-bar"
        className="shrink-0 border-t border-[#E7E2DA] bg-white px-4 sm:px-6 py-2.5 space-y-0.5"
      >
        {sumLines.length === 0 ? (
          <div className="text-xs text-[#57534E]" data-testid="review-sum-none">
            No rows ticked · tick a row to add its net at the latest price seen
          </div>
        ) : (
          sumLines.map((b) => (
            <div
              key={b.currency}
              data-testid="review-sum"
              data-currency={b.currency}
              data-sum={b.sum}
              data-summed={b.summed}
              data-selected={b.selected}
              className="text-xs text-[#141413] flex flex-wrap items-baseline gap-x-1.5"
            >
              <span className="font-mono-num font-semibold text-[#8C857B]">{b.currency}</span>
              <span>{describeSumLine(b)}</span>
              {(b.feeNotConfirmed > 0 || b.noPrice > 0) && (
                <span className="text-[#8C857B]">
                  · left out:{' '}
                  {[
                    b.feeNotConfirmed > 0 ? `${b.feeNotConfirmed} fee not confirmed` : null,
                    b.noPrice > 0 ? `${b.noPrice} no price seen` : null,
                  ]
                    .filter(Boolean)
                    .join(', ')}
                </span>
              )}
            </div>
          ))
        )}
        <div className="text-[10px] text-[#8C857B]">
          Only rows with every cost line ticked are summed · KRW and USD kept apart · Sample never
          summed · nothing is listed, posted or paid
        </div>
      </div>
    </section>
  );
};
