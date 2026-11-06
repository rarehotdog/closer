import React, { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import type { AccountState } from '../utils/accountWardrobe';
import { CanonicalLedgerPanel } from './CanonicalLedgerPanel';
import {
  X,
  Check,
  Lock,
  Copy,
  Share2,
  GitBranch,
  Download,
  ExternalLink,
  ShieldAlert,
  Sparkles,
  ArrowRightLeft,
  ClipboardPaste,
  Camera,
  Loader2,
  Upload,
} from 'lucide-react';
import {
  CurrencyCode,
  GarmentCategory,
  GarmentPiece,
  GarmentSilhouette,
  LedgerSummary,
  ResalePlatform,
  TargetLook,
} from '../types/closet';
import { platformsForCurrency } from '../data/seedCloset';
import {
  compute30DayRotationTrend,
  computeGarmentRotationHeat,
  computeNetPayout,
  computeSameSeriesSparkline,
  createHungPiece,
  evaluatePreCheckoutGate,
  evaluateTargetLook,
  formatCurrency,
  formatSignedCurrency,
  getLatestObservation,
  hasFactsMoved,
  parseQuickOrderLine,
  plural,
  REFERENCE_DATE,
} from '../utils/ledgerLogic';
import {
  modeLine,
  scanAttempted,
  samplePreviewOnly,
  NAMED_HEX,
  prepare,
  SHAPE,
  type ScanFail,
  type ScanMode,
  type ScanOk,
} from './ScanPhotoModal';

const kindWord = (kind: 'traded' | 'listed', count: number) =>
  kind === 'traded' ? (count === 1 ? 'trade' : 'trades') : count === 1 ? 'ask' : 'asks';

interface LedgerD3SparklineProps {
  piece: GarmentPiece;
}

/**
 * Price records of ONE platform and kind (the latest record's), drawn as a sparkline. A change is
 * shown only when that series has 2+ records; other platforms are never joined into the line.
 */
const LedgerD3Sparkline: React.FC<LedgerD3SparklineProps> = ({ piece }) => {
  const spark = computeSameSeriesSparkline(piece);
  const width = 88;
  const height = 26;
  const padX = 4;
  const padY = 4;

  if (spark.status === 'none' || spark.points.length === 0) {
    return (
      <div
        className="inline-flex items-center justify-end gap-2"
        data-testid={`ledger-sparkline-${piece.code}`}
        data-trend="none"
      >
        <span className="text-[10px] text-[#8C857B]">No price on record</span>
      </div>
    );
  }

  const prices = spark.points.map((p) => p.price);
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const domainPad = maxP === minP ? Math.max(1, minP * 0.05) : (maxP - minP) * 0.15;

  const xScale = d3
    .scaleLinear()
    .domain([0, Math.max(1, spark.points.length - 1)])
    .range([padX, width - padX]);

  const yScale = d3
    .scaleLinear()
    .domain([minP - domainPad, maxP + domainPad])
    .range([height - padY, padY]);

  const lineGenerator = d3
    .line<{ date: string; price: number }>()
    .x((_, i) => xScale(i))
    .y((d) => yScale(d.price))
    .curve(d3.curveMonotoneX);

  const areaGenerator = d3
    .area<{ date: string; price: number }>()
    .x((_, i) => xScale(i))
    .y0(height - 2)
    .y1((d) => yScale(d.price))
    .curve(d3.curveMonotoneX);

  const isSeries = spark.status === 'series';
  const linePath = isSeries ? (lineGenerator(spark.points) ?? '') : '';
  const areaPath = isSeries ? (areaGenerator(spark.points) ?? '') : '';

  const strokeColor =
    spark.direction === 'up'
      ? '#F37021'
      : spark.direction === 'down'
        ? '#2563EB'
        : '#8C857B';

  const fillColor =
    spark.direction === 'up'
      ? 'rgba(243, 112, 33, 0.14)'
      : spark.direction === 'down'
        ? 'rgba(37, 99, 235, 0.12)'
        : 'rgba(140, 133, 123, 0.10)';

  const lastIdx = spark.points.length - 1;
  const lastX = isSeries ? xScale(lastIdx) : width / 2;
  const lastY = yScale(spark.points[lastIdx].price);
  const firstX = xScale(0);
  const firstY = yScale(spark.points[0].price);

  const seriesText = `${spark.count} ${spark.platform} ${spark.kind ? kindWord(spark.kind, spark.count) : ''}`;
  const hasSample = spark.points.some((p) => p.isSample);

  return (
    <div
      className="inline-flex items-center justify-end gap-2"
      data-testid={`ledger-sparkline-${piece.code}`}
      data-trend={spark.direction ?? 'single'}
    >
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="overflow-visible shrink-0"
        role="img"
        aria-label={
          isSeries && spark.deltaPct !== null
            ? `${piece.code}: ${spark.deltaPct > 0 ? '+' : ''}${spark.deltaPct}% across ${seriesText} (${spark.firstDate} to ${spark.lastDate})`
            : `${piece.code}: ${seriesText} on record, no change computed`
        }
      >
        {areaPath && <path d={areaPath} fill={fillColor} />}
        {linePath && (
          <path
            d={linePath}
            fill="none"
            stroke={strokeColor}
            strokeWidth={1.75}
            strokeLinecap="round"
          />
        )}
        {isSeries && (
          <circle
            cx={firstX}
            cy={firstY}
            r={1.75}
            fill="#FFFFFF"
            stroke={strokeColor}
            strokeWidth={1.25}
          />
        )}
        <circle cx={lastX} cy={lastY} r={2.4} fill={strokeColor} />
      </svg>
      <div className="text-right min-w-[52px]">
        <div
          className={`text-[11px] font-mono-num font-semibold leading-tight ${
            spark.direction === 'up'
              ? 'text-[#F37021]'
              : spark.direction === 'down'
                ? 'text-[#2563EB]'
                : 'text-[#8C857B]'
          }`}
        >
          {isSeries && spark.deltaPct !== null
            ? `${spark.deltaPct > 0 ? '+' : ''}${spark.deltaPct}% ${
                spark.direction === 'up'
                  ? '▲'
                  : spark.direction === 'down'
                    ? '▼'
                    : '—'
              }`
            : '—'}
        </div>
        <div className="text-[9px] text-[#8C857B] font-mono-num leading-tight max-w-[76px] ml-auto">
          {seriesText}
          {hasSample ? ' · Sample' : ''}
        </div>
      </div>
    </div>
  );
};

interface LedgerModalProps {
  isOpen: boolean;
  scope?: 'account' | 'sample' | 'browser';
  accountState?: AccountState;
  onClose: () => void;
  garments: GarmentPiece[];
  summary: LedgerSummary;
  onSelectGarment: (id: string) => void;
}

export const LedgerModal: React.FC<LedgerModalProps> = ({
  isOpen,
  scope = 'browser',
  accountState,
  onClose,
  garments,
  summary,
  onSelectGarment,
}) => {
  if (!isOpen) return null;

  const isAccount = scope === 'account';
  const now = new Date();
  const accountDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const rotationTrend = compute30DayRotationTrend(garments, isAccount ? accountDate : REFERENCE_DATE);

  const totalSeenOwned =
    summary.krw.ownedSeenCount + summary.usd.ownedSeenCount;

  // SVG Donut Chart geometry for the 30-day Keep vs Sell DECISION counts (nothing here was sold)
  const donutRadius = 30;
  const donutCircumference = 2 * Math.PI * donutRadius;
  const keptStrokeLength =
    (rotationTrend.keptShare / 100) * donutCircumference;
  const sellDecidedStrokeLength =
    (rotationTrend.sellDecidedShare / 100) * donutCircumference;

  const pricedNote = (priced: number, total: number) =>
    priced < total ? ` (${priced} of ${total} have a price)` : '';

  return (
    <div
      className="fixed inset-0 z-40 bg-black/25 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={isAccount ? 'Your Closet at a Glance Asset Ledger' : 'Sample Closet at a Glance Asset Ledger'}
    >
      <div className="bg-white border border-[#E7E2DA] rounded-2xl max-w-4xl w-full max-h-[88vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E7E2DA]">
          <div>
            <h2 className="text-xl font-display font-semibold text-[#141413]">
              {isAccount ? 'Your Closet at a Glance' : 'Sample Closet at a Glance'} · Asset Ledger
            </h2>
            <p className="text-xs text-[#8C857B]">
              {isAccount
                ? 'Your pieces on record · Separated by currency · '
                : `${scope === 'browser' ? 'Sample data plus pieces you added' : 'Sample data'} · Separated by currency · Sample pieces kept apart, never added to yours · `}
              Price on record for{' '}
              {totalSeenOwned} of {summary.totalOwnedPieces} pieces
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close ledger modal"
            className="p-2 rounded-lg text-[#57534E] hover:text-[#141413] hover:bg-[#FAF8F5]"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {isAccount && accountState && <details className="px-6 py-3 border-b border-[#E7E2DA]">
            <summary className="text-sm font-medium cursor-pointer min-h-9 flex items-center">Saved ledger &amp; photo analysis history</summary>
            <CanonicalLedgerPanel key={accountState.account?.workspaceId} state={accountState} />
          </details>}
          {/* Summary Cards by Currency + 30-Day Decision Donut & Progress Bar */}
          <div className="px-6 py-4 bg-[#FAF8F5] border-b border-[#E7E2DA] space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
              {(['krw', 'usd'] as const).map((key) => {
                const bucket = summary[key];
                const cur: CurrencyCode = key === 'krw' ? 'KRW' : 'USD';
                return (
                  <div
                    key={key}
                    className="bg-white border border-[#E7E2DA] rounded-xl p-4"
                    data-testid={`ledger-bucket-${cur}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-[#8C857B] font-medium">
                        {cur} ({cur === 'KRW' ? '₩' : '$'}) · Latest Price Seen,
                        Summed
                      </span>
                      <span className="text-[10px] font-mono-num px-2 py-0.5 rounded bg-[#FAF8F5] border border-[#E7E2DA] text-[#57534E] whitespace-nowrap">
                        Priced {bucket.ownedSeenCount}/{bucket.ownedTotalPieces}{' '}
                        pieces
                      </span>
                    </div>
                    <div className="text-2xl font-mono-num font-semibold text-[#141413] mt-1">
                      {formatCurrency(bucket.ownedTotalLatest, cur)}
                    </div>
                    <div className="text-xs text-[#57534E] mt-1">
                      <span>
                        Latest price seen on {bucket.ownedSeenCount} of{' '}
                        {bucket.ownedTotalPieces} {cur} pieces
                      </span>
                      <span aria-hidden="true"> · </span>
                      <span>
                        {plural(bucket.tradedCount, 'trade')} ·{' '}
                        {plural(bucket.listedCount, 'ask')}
                      </span>
                    </div>
                    <div className="text-[11px] text-[#8C857B] mt-2 pt-2 border-t border-[#E7E2DA]">
                      Net with every cost checked, at latest price seen:{' '}
                      {formatCurrency(bucket.confirmedNetTotal, cur)} on{' '}
                      {bucket.confirmedNetCount} of {bucket.ownedTotalPieces}{' '}
                      {cur} pieces
                    </div>
                    {bucket.sampleSeenCount > 0 && (
                      <div className="text-[11px] text-[#8C857B] mt-1">
                        Sample {formatCurrency(bucket.sampleTotalLatest, cur)}{' '}
                        kept apart, never added to yours
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* 30-Day Keep vs Sell decisions (Donut + Progress Bar + 4-Week Cadence) */}
            <div
              className="bg-white border border-[#E7E2DA] rounded-xl p-4"
              data-testid="rotation-trend-30d"
            >
              <div className="flex flex-wrap items-center justify-between gap-4 mb-3">
                <div>
                  <div className="text-xs font-semibold text-[#141413]">
                    30-Day Wardrobe Decisions · Keep vs Sell{isAccount ? '' : ' (Sample Data)'}
                  </div>
                  <div className="text-[11px] text-[#8C857B] mt-0.5">
                    Decisions saved in the last 30 days:{' '}
                    {rotationTrend.totalDecided30d} of{' '}
                    {rotationTrend.ownedPieces} pieces · a Sell decision is not a
                    sale (no sale records)
                  </div>
                </div>

                <div className="flex items-center gap-5 text-xs font-mono-num">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-sm bg-[#141413] inline-block" />
                    <span className="font-semibold text-[#141413]">
                      {rotationTrend.keptLast30d} Keep
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-sm bg-[#F37021] inline-block" />
                    <span className="font-semibold text-[#F37021]">
                      {rotationTrend.sellDecidedLast30d} Sell (decided)
                    </span>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-center">
                {/* SVG Donut Chart */}
                <div className="md:col-span-3 flex items-center gap-3">
                  <div className="relative w-20 h-20 shrink-0">
                    <svg
                      viewBox="0 0 80 80"
                      className="w-20 h-20 -rotate-90"
                      data-testid="rotation-donut-chart"
                      role="img"
                      aria-label={`Decisions in the last 30 days: ${rotationTrend.keptLast30d} Keep, ${rotationTrend.sellDecidedLast30d} Sell, of ${rotationTrend.totalDecided30d}`}
                    >
                      <circle
                        cx="40"
                        cy="40"
                        r={donutRadius}
                        fill="none"
                        stroke="#FAF8F5"
                        strokeWidth="10"
                      />
                      {/* Keep Arc */}
                      <circle
                        cx="40"
                        cy="40"
                        r={donutRadius}
                        fill="none"
                        stroke="#141413"
                        strokeWidth="10"
                        strokeDasharray={`${keptStrokeLength} ${donutCircumference}`}
                        strokeDashoffset={0}
                      />
                      {/* Sell-decision Arc in Hermès Orange */}
                      <circle
                        cx="40"
                        cy="40"
                        r={donutRadius}
                        fill="none"
                        stroke="#F37021"
                        strokeWidth="10"
                        strokeDasharray={`${sellDecidedStrokeLength} ${donutCircumference}`}
                        strokeDashoffset={-keptStrokeLength}
                      />
                    </svg>
                    <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
                      <span className="text-xs font-mono-num font-bold text-[#141413]">
                        {rotationTrend.keptLast30d}:{rotationTrend.sellDecidedLast30d}
                      </span>
                      <span className="text-[9px] text-[#8C857B]">Keep:Sell</span>
                    </div>
                  </div>

                  <div className="text-[11px] space-y-0.5">
                    <div className="font-semibold text-[#141413]">
                      {plural(rotationTrend.totalDecided30d, 'decision')} in 30
                      days
                    </div>
                    <div className="text-[10px] text-[#8C857B]">
                      {rotationTrend.keptLast30d} Keep ·{' '}
                      {rotationTrend.sellDecidedLast30d} Sell · 0 sold on record
                    </div>
                  </div>
                </div>

                {/* Horizontal Split Progress Bar */}
                <div className="md:col-span-6 space-y-1.5">
                  <div
                    className="w-full h-3.5 rounded-full bg-[#FAF8F5] border border-[#E7E2DA] overflow-hidden flex"
                    data-testid="rotation-progress-bar"
                  >
                    <div
                      style={{ width: `${rotationTrend.keptShare}%` }}
                      className="h-full bg-[#141413] transition-all duration-300"
                      title={`Keep decisions: ${rotationTrend.keptLast30d}`}
                    />
                    <div
                      style={{ width: `${rotationTrend.sellDecidedShare}%` }}
                      className="h-full bg-[#F37021] transition-all duration-300"
                      title={`Sell decisions: ${rotationTrend.sellDecidedLast30d}`}
                    />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-x-3 text-[11px] text-[#57534E] font-mono-num">
                    <span>
                      Keep, at latest price seen:{' '}
                      {formatCurrency(rotationTrend.keptValuationKRW, 'KRW')} ·{' '}
                      {formatCurrency(rotationTrend.keptValuationUSD, 'USD')}
                      {pricedNote(
                        rotationTrend.keptPricedCount,
                        rotationTrend.keptLast30d,
                      )}
                    </span>
                    <span className="text-[#F37021] font-medium">
                      Sell, at latest price seen:{' '}
                      {formatCurrency(rotationTrend.sellDecidedValuationUSD, 'USD')}{' '}
                      · {formatCurrency(rotationTrend.sellDecidedValuationKRW, 'KRW')}
                      {pricedNote(
                        rotationTrend.sellDecidedPricedCount,
                        rotationTrend.sellDecidedLast30d,
                      )}
                    </span>
                  </div>
                </div>

                {/* 4-Week Mini Cadence Bars (decision counts per week) */}
                <div className="md:col-span-3 flex items-end justify-between gap-2 pl-2 border-l border-[#E7E2DA]">
                  {rotationTrend.weeklyBuckets.map((wb) => {
                    const maxH = 28;
                    const kH = Math.min(maxH, wb.kept * 8);
                    const sH = Math.min(maxH, wb.sellDecided * 8);
                    return (
                      <div
                        key={wb.label}
                        className="flex-1 flex flex-col items-center gap-1"
                      >
                        <div className="h-7 flex items-end gap-1">
                          <span
                            style={{ height: `${Math.max(2, kH)}px` }}
                            className={`w-2 rounded-t bg-[#141413] ${wb.kept === 0 ? 'opacity-20' : ''}`}
                            title={`${wb.label} Keep decisions: ${wb.kept}`}
                          />
                          <span
                            style={{ height: `${Math.max(2, sH)}px` }}
                            className={`w-2 rounded-t bg-[#F37021] ${wb.sellDecided === 0 ? 'opacity-20' : ''}`}
                            title={`${wb.label} Sell decisions: ${wb.sellDecided}`}
                          />
                        </div>
                        <span className="text-[10px] font-mono-num text-[#8C857B] whitespace-nowrap text-center leading-tight">
                          {wb.label}
                          <br />
                          {wb.kept}·{wb.sellDecided}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* Tabular Archive List */}
          <div className="px-6 py-3 overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#E7E2DA] text-[11px] text-[#8C857B] font-medium">
                  <th className="py-2.5 pr-3">Code</th>
                  <th className="py-2.5 px-3">Piece</th>
                  <th className="py-2.5 px-3">Platform</th>
                  <th className="py-2.5 px-3 text-right">
                    Price Change · Same Platform (D3)
                  </th>
                  <th className="py-2.5 px-3 text-right">Latest Price Seen</th>
                  <th className="py-2.5 px-3 text-right">
                    Net at Latest (Fees Checked)
                  </th>
                  <th className="py-2.5 pl-3 text-right">Position</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E7E2DA] text-xs">
                {garments.map((g) => {
                  const latest = getLatestObservation(g);
                  const net = computeNetPayout(
                    latest?.price ?? null,
                    g.feeConfig.feeRatePct,
                    g.feeConfig.shippingCost,
                    g.feeConfig.confirmed,
                  );
                  const moved = hasFactsMoved(g);
                  const heat = computeGarmentRotationHeat(g);

                  return (
                    <tr
                      key={g.id}
                      data-testid={`ledger-row-${g.code}`}
                      onClick={() => {
                        onSelectGarment(g.id);
                        onClose();
                      }}
                      className="hover:bg-[#FAF8F5] cursor-pointer transition-colors"
                    >
                      <td className="py-3 pr-3 font-mono-num font-semibold text-[#141413]">
                        <div className="flex items-center gap-1.5">
                          <span
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{ backgroundColor: heat.heatColorHex }}
                            title={
                              heat.wearsLast60Days === null
                                ? 'Rotation Heat: no wear log'
                                : `Rotation Heat: ${heat.label} (${heat.wearsLast60Days} logged)`
                            }
                          />
                          <span>{g.code}</span>
                        </div>
                      </td>
                      <td className="py-3 px-3">
                        <div className="font-medium text-[#141413] flex items-center gap-1.5">
                          <span>{g.name}</span>
                          <span
                            className="text-[9px] font-mono-num px-1.5 py-0.5 rounded border whitespace-nowrap"
                            style={{
                              backgroundColor: heat.tagBgHex,
                              borderColor: heat.tagBorderHex,
                              color: heat.tagTextHex,
                            }}
                          >
                            {heat.wearsLast60Days === null
                              ? 'no wear log'
                              : `${heat.wearsLast60Days}x · ${heat.shortLabel}`}
                          </span>
                        </div>
                        <div className="text-[11px] text-[#8C857B]">
                          {g.brand || 'Brand not entered'} · {g.fabricLabel}
                        </div>
                      </td>
                      <td className="py-3 px-3 text-[#57534E]">
                        {latest
                          ? `${latest.platform} (${latest.kind === 'traded' ? 'trade' : 'ask'})${latest.isSample ? ' · Sample' : ''}`
                          : '—'}
                      </td>
                      <td className="py-3 px-3 text-right">
                        <LedgerD3Sparkline piece={g} />
                      </td>
                      <td className="py-3 px-3 text-right font-mono-num font-semibold text-[#141413]">
                        {latest ? formatCurrency(latest.price, g.currency) : 'No price on record'}
                      </td>
                      <td className="py-3 px-3 text-right font-mono-num text-[#57534E]">
                        {net.status === 'confirmed' && net.netPayout !== null
                          ? formatCurrency(net.netPayout, g.currency)
                          : latest
                            ? 'Fee not confirmed'
                            : '—'}
                      </td>
                      <td className="py-3 pl-3 text-right whitespace-nowrap">
                        {g.isSample ? (
                          <span className="text-[#8C857B]">Sample</span>
                        ) : (
                          <span
                            className={`font-medium ${
                              g.lastDecision?.choice === 'sell'
                                ? 'text-[#F37021]'
                                : 'text-[#141413]'
                            }`}
                          >
                            {g.lastDecision?.choice === 'sell'
                              ? 'Sell'
                              : g.lastDecision?.choice === 'keep'
                                ? 'Keep'
                                : 'Undecided'}
                            {moved ? ' · Price moved' : ''}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};

interface GitHubShareModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedPieceCode: string | null;
  viewMode: 'rail' | 'vault';
  garments: GarmentPiece[];
}

export const GitHubShareModal: React.FC<GitHubShareModalProps> = ({
  isOpen,
  onClose,
  selectedPieceCode,
  viewMode,
  garments,
}) => {
  const [repoSlug, setRepoSlug] = useState('rarehotdog/closer');
  const [branchName, setBranchName] = useState('antigravity/beverly-hills-3d');
  const [copied, setCopied] = useState<{ key: string; ok: boolean } | null>(
    null,
  );
  // This modal only READS public repo metadata (unauthenticated GET) and copies text.
  // It never pushes, configures or changes any repository.
  const [repoStatus, setRepoStatus] = useState<{
    state: 'idle' | 'checking' | 'found' | 'failed';
    message: string;
  }>({
    state: 'idle',
    message:
      'Not checked yet. "Check Repo" only reads public repo info; this app cannot push.',
  });

  if (!isOpen) return null;

  const shareUrl = `${window.location.origin}${window.location.pathname}?view=${viewMode}${
    selectedPieceCode ? `&piece=${selectedPieceCode}` : ''
  }`;

  const gitPushCommand = `gh auth status && git checkout -B ${branchName} && git add web/public/closet3d.js web/public/app.css && git commit -m "feat(3d): boutique rail front-shot & hermes orange theme" && git push -u origin ${branchName}`;

  // "Copied" only after the browser confirms the clipboard write.
  const handleCopy = async (key: string, text: string) => {
    let ok = false;
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = false;
    }
    setCopied({ key, ok });
    setTimeout(() => setCopied(null), 2000);
  };

  const handleVerifyRepo = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = repoSlug.trim().replace(/^https?:\/\/github\.com\//, '');
    if (!cleaned.includes('/')) {
      setRepoStatus({
        state: 'failed',
        message:
          'Enter the repository as owner/repo (e.g. rarehotdog/closer). Nothing was checked.',
      });
      return;
    }
    setRepoStatus({
      state: 'checking',
      message: `Checking github.com/${cleaned} (read-only)...`,
    });
    try {
      const res = await fetch(`https://api.github.com/repos/${cleaned}`);
      if (res.ok) {
        const data = await res.json();
        setRepoStatus({
          state: 'found',
          message: `Found public repo ${data.full_name} (default branch: ${data.default_branch}). This app does not push.`,
        });
      } else {
        setRepoStatus({
          state: 'failed',
          message: `Could not check github.com/${cleaned} (HTTP ${res.status}). Nothing was configured or pushed.`,
        });
      }
    } catch {
      setRepoStatus({
        state: 'failed',
        message: `Could not check github.com/${cleaned} (network error). Nothing was configured or pushed.`,
      });
    }
  };

  const handleDownloadJsonSnapshot = () => {
    const payload = {
      repository: repoSlug,
      branch: branchName,
      theme: {
        canvas: '#FFFFFF',
        alabaster: '#FAF8F5',
        accentHermesOrange: '#F37021',
        champagneBrass: '#C5A572',
      },
      viewMode,
      selectedPieceCode,
      garmentCount: garments.length,
      garments,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'closer-boutique-rail-bundle.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyLabel = (key: string, idle: string, done: string) =>
    copied?.key === key ? (copied.ok ? done : 'Copy failed · select it') : idle;

  return (
    <div
      className="fixed inset-0 z-40 bg-black/25 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Share link and GitHub command (copy only)"
    >
      <div className="bg-white border border-[#E7E2DA] rounded-2xl max-w-xl w-full max-h-[92vh] overflow-y-auto p-6 shadow-2xl space-y-5">
        <div className="flex items-center justify-between pb-3.5 border-b border-[#E7E2DA]">
          <div className="flex items-center gap-2.5">
            <GitBranch className="w-5 h-5 text-[#F37021] shrink-0" />
            <div>
              <h2 className="text-lg font-display font-semibold text-[#141413]">
                Share Link &amp; GitHub Command (Copy Only)
              </h2>
              <p className="text-xs text-[#8C857B]">
                Copies a link and a git command. This app only reads public repo
                info; it does not push or change any repository.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close GitHub share modal"
            className="p-1.5 rounded-lg text-[#57534E] hover:text-[#141413]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 1. Direct Shareable URL */}
        <div className="bg-[#FAF8F5] border border-[#E7E2DA] rounded-xl p-4 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-x-2">
            <span className="text-xs font-semibold text-[#141413] flex items-center gap-1.5">
              <Share2 className="w-3.5 h-3.5 text-[#F37021]" />
              <span>Shareable Boutique Rail Link</span>
            </span>
            <span className="text-[11px] text-[#8C857B] font-mono-num">
              {selectedPieceCode
                ? `Opens ${selectedPieceCode} in Front Shot`
                : `Opens ${viewMode.toUpperCase()} view`}
            </span>
          </div>

          <p className="text-[11px] text-[#8C857B]">
            The link opens this view on the sample closet; your changes stay in
            this browser.
          </p>

          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              aria-label="Shareable boutique rail URL"
              value={shareUrl}
              className="flex-1 min-w-0 px-3 py-2 text-xs font-mono-num bg-white border border-[#E7E2DA] rounded-lg text-[#141413]"
            />
            <button
              type="button"
              onClick={() => handleCopy('shareUrl', shareUrl)}
              className="px-3.5 py-2 text-xs font-semibold bg-[#F37021] text-white rounded-lg hover:bg-[#D95D12] transition-colors inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              {copied?.key === 'shareUrl' && copied.ok ? (
                <Check className="w-3.5 h-3.5" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
              <span>{copyLabel('shareUrl', 'Copy Link', 'Copied')}</span>
            </button>
          </div>
        </div>

        {/* 2. Read-only public repo check */}
        <form onSubmit={handleVerifyRepo} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label
                htmlFor="gh-repo-slug"
                className="block text-xs font-medium text-[#57534E] mb-1"
              >
                GitHub Repository
              </label>
              <input
                id="gh-repo-slug"
                type="text"
                value={repoSlug}
                onChange={(e) => setRepoSlug(e.target.value)}
                placeholder="rarehotdog/closer"
                className="w-full px-3 py-2 text-xs font-mono-num border border-[#E7E2DA] rounded-lg text-[#141413]"
              />
            </div>
            <div>
              <label
                htmlFor="gh-branch-name"
                className="block text-xs font-medium text-[#57534E] mb-1"
              >
                Branch Named in the Command
              </label>
              <input
                id="gh-branch-name"
                type="text"
                value={branchName}
                onChange={(e) => setBranchName(e.target.value)}
                placeholder="antigravity/beverly-hills-3d"
                className="w-full px-3 py-2 text-xs font-mono-num border border-[#E7E2DA] rounded-lg text-[#141413]"
              />
            </div>
          </div>

          <div
            className={`flex items-center justify-between gap-3 rounded-lg px-3.5 py-2.5 border ${
              repoStatus.state === 'failed'
                ? 'bg-[#FAF8F5] border-[#E7E2DA]'
                : 'bg-[#FFF3EB] border-[#F37021]/30'
            }`}
          >
            <span
              className="text-xs text-[#141413] font-medium"
              data-testid="repo-check-status"
              data-state={repoStatus.state}
              role="status"
            >
              {repoStatus.message}
            </span>
            <button
              type="submit"
              disabled={repoStatus.state === 'checking'}
              className="px-3 py-1 text-xs font-semibold bg-[#141413] text-white rounded-md hover:bg-[#F37021] transition-colors whitespace-nowrap shrink-0 disabled:opacity-60"
            >
              Check Repo (Read-Only)
            </button>
          </div>
        </form>

        {/* 3. Git command to copy & run yourself + local JSON export */}
        <div className="space-y-2 pt-1 border-t border-[#E7E2DA]">
          <div className="text-xs font-semibold text-[#141413]">
            Git Command for <code className="font-mono-num">{repoSlug}</code>{' '}
            <span className="font-normal text-[#8C857B]">
              (copy and run it yourself; this app does not run it or create the
              files it names)
            </span>
          </div>
          <div className="p-2.5 rounded-lg bg-[#FAF8F5] border border-[#E7E2DA] font-mono-num text-[11px] text-[#57534E] overflow-x-auto whitespace-nowrap">
            {gitPushCommand}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => handleCopy('gitCmd', gitPushCommand)}
                className="px-3 py-1.5 text-xs font-medium bg-white border border-[#E7E2DA] rounded-lg hover:border-[#F37021] text-[#141413] inline-flex items-center gap-1.5"
              >
                {copied?.key === 'gitCmd' && copied.ok ? (
                  <Check className="w-3.5 h-3.5 text-[#F37021]" />
                ) : (
                  <Copy className="w-3.5 h-3.5 text-[#F37021]" />
                )}
                <span>
                  {copyLabel('gitCmd', 'Copy Git Command', 'Command Copied')}
                </span>
              </button>

              <button
                type="button"
                onClick={handleDownloadJsonSnapshot}
                className="px-3 py-1.5 text-xs font-medium bg-white border border-[#E7E2DA] rounded-lg hover:border-[#141413] text-[#141413] inline-flex items-center gap-1.5"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Download Closet JSON</span>
              </button>
            </div>

            <a
              href={`https://github.com/${repoSlug.replace(/^https?:\/\/github\.com\//, '')}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-semibold text-[#F37021] hover:underline inline-flex items-center gap-1"
            >
              <span>Open GitHub</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>
        </div>

        {/* 4. Concise Help Guide: How to Commit Changes to GitHub from AI Studio */}
        <div
          data-testid="github-commit-help-section"
          className="p-3.5 rounded-xl bg-[#FAF8F5] border border-[#E7E2DA] space-y-2"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-[#141413] flex items-center gap-1.5">
              <GitBranch className="w-3.5 h-3.5 text-[#F37021]" />
              <span>How to Save &amp; Commit Changes to GitHub from AI Studio</span>
            </span>
            <span className="text-[10px] font-mono-num px-1.5 py-0.5 rounded bg-white border border-[#E7E2DA] text-[#57534E]">
              3-Step Guide
            </span>
          </div>
          <ol className="text-[11px] text-[#57534E] space-y-1.5 list-decimal list-inside leading-relaxed">
            <li>
              <strong className="text-[#141413]">Save in AI Studio:</strong> Click{' '}
              <span className="font-mono-num font-semibold text-[#141413]">Save</span> (or press{' '}
              <kbd className="px-1 py-0.5 text-[10px] bg-white border border-[#E7E2DA] rounded font-mono-num">
                Ctrl+S
              </kbd>{' '}
              /{' '}
              <kbd className="px-1 py-0.5 text-[10px] bg-white border border-[#E7E2DA] rounded font-mono-num">
                Cmd+S
              </kbd>
              ) in the top-right AI Studio toolbar so your project is pinned to{' '}
              <span className="font-semibold text-[#141413]">My Library / Saved Apps</span>.
            </li>
            <li>
              <strong className="text-[#141413]">Direct GitHub Export or ZIP:</strong> Click the{' '}
              <span className="font-semibold text-[#141413]">GitHub (Export to GitHub)</span> icon in
              the AI Studio top toolbar to push directly, or click{' '}
              <span className="font-semibold text-[#141413]">Download App (ZIP)</span> +{' '}
              <span className="font-semibold text-[#141413]">Download Closet JSON</span> above.
            </li>
            <li>
              <strong className="text-[#141413]">Commit &amp; Push to Branch:</strong> Click{' '}
              <span className="font-semibold text-[#F37021]">Copy Push Command</span> above and run it
              in your local repository terminal to create branch{' '}
              <code className="font-mono-num text-[#141413]">{branchName}</code>, commit your wardrobe
              ledger &amp; 3D changes, and push to <code className="font-mono-num text-[#141413]">{repoSlug}</code>.
            </li>
          </ol>
        </div>
      </div>
    </div>
  );
};

interface LooksModalProps {
  isOpen: boolean;
  onClose: () => void;
  looks: TargetLook[];
  garments: GarmentPiece[];
  onLockLookForToday: (pieceCodes: string[]) => void;
}

// Example candidate purchases (typed in by the design, not fetched from any shop).
const PRE_CHECKOUT_PRESETS: {
  id: string;
  brand: string;
  name: string;
  category: GarmentCategory;
  price: number;
  currency: CurrencyCode;
}[] = [
  {
    id: 'cand-1',
    brand: 'LEMAIRE',
    name: 'Wrap Double-Faced Wool Overcoat',
    category: 'outerwear',
    price: 2150000,
    currency: 'KRW',
  },
  {
    id: 'cand-2',
    brand: 'OUR LEGACY',
    name: 'Washed Black Zip Hooded Sweatshirt',
    category: 'hoodie',
    price: 245,
    currency: 'USD',
  },
  {
    id: 'cand-3',
    brand: 'DRIES VAN NOTEN',
    name: 'Structured Crisp Poplin Shirt',
    category: 'shirt',
    price: 590000,
    currency: 'KRW',
  },
];

export const LooksModal: React.FC<LooksModalProps> = ({
  isOpen,
  onClose,
  looks,
  garments,
  onLockLookForToday,
}) => {
  const [selectedCandidateIdx, setSelectedCandidateIdx] = useState(0);

  if (!isOpen) return null;

  const lockedPieces = garments.filter((g) => g.lockedForToday);
  const candidate = PRE_CHECKOUT_PRESETS[selectedCandidateIdx];
  const preCheckout = evaluatePreCheckoutGate(candidate, garments);

  return (
    <div
      className="fixed inset-0 z-40 bg-black/25 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Target Looks and Pre-Checkout Gate"
    >
      <div className="bg-white border border-[#E7E2DA] rounded-2xl max-w-3xl w-full max-h-[86vh] flex flex-col shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E7E2DA]">
          <div>
            <h2 className="text-xl font-display font-semibold text-[#141413]">
              Target Looks &amp; Pre-Checkout Gate
            </h2>
            <p className="text-xs text-[#8C857B]">
              Lock curated combinations onto your rail · Check example purchases
              against the pieces on the rail &amp; a 1:1 swap assumption
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close looks modal"
            className="p-2 rounded-lg text-[#57534E] hover:text-[#141413] hover:bg-[#FAF8F5]"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-5 overflow-y-auto">
          {/* Today Locked Banner */}
          <div className="p-4 rounded-xl bg-[#FFF3EB] border border-[#F37021]/30 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-[#F37021] flex items-center gap-1.5">
                <Lock className="w-3.5 h-3.5" />
                <span>Locked for Today</span>
              </div>
              <div className="text-sm font-medium text-[#141413] mt-0.5">
                {lockedPieces.length > 0
                  ? lockedPieces.map((p) => `${p.code} (${p.name})`).join(' + ')
                  : 'No pieces locked for today'}
              </div>
            </div>
            <span className="text-xs font-mono-num font-semibold text-[#141413] whitespace-nowrap">
              {plural(lockedPieces.length, 'piece')}
            </span>
          </div>

          {/* PRE-CHECKOUT GATE (Duplicate Alert + New Outfits Unlocked + 1:1 Swap Assumption) */}
          <div
            className="p-4 rounded-xl bg-[#FAF8F5] border border-[#E7E2DA] space-y-3"
            data-testid="pre-checkout-gate"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-xs font-semibold text-[#141413] flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-[#F37021]" />
                  <span>
                    Check Before Checkout · Pre-Checkout Gate (Overlap &amp; 1:1
                    Swap)
                  </span>
                </div>
                <div className="text-[11px] text-[#8C857B]">
                  Before buying, count category overlap and the 3-piece outfits it
                  completes, and the price difference IF one piece on the rail
                  sold at its latest price seen (an assumption)
                </div>
              </div>
            </div>

            {/* Candidate Selector */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {PRE_CHECKOUT_PRESETS.map((item, idx) => (
                <button
                  key={item.id}
                  type="button"
                  data-testid={`checkout-candidate-${idx}`}
                  onClick={() => setSelectedCandidateIdx(idx)}
                  className={`p-2.5 rounded-lg border text-left transition-colors ${
                    selectedCandidateIdx === idx
                      ? 'bg-white border-[#F37021] shadow-sm'
                      : 'bg-white/60 border-[#E7E2DA] hover:border-[#141413]'
                  }`}
                >
                  <div className="text-[10px] font-semibold text-[#8C857B]">
                    Example · {item.brand} · {item.category.toUpperCase()}
                  </div>
                  <div className="text-xs font-semibold text-[#141413] truncate mt-0.5">
                    {item.name}
                  </div>
                  <div className="text-xs font-mono-num font-bold text-[#F37021] mt-1">
                    {formatCurrency(item.price, item.currency)}
                  </div>
                </button>
              ))}
            </div>

            {/* 3-Column Gate Verdict */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5 pt-1">
              {/* 1. Duplicate Alert */}
              <div className="p-3 rounded-lg bg-white border border-[#E7E2DA] space-y-1">
                <div className="text-[11px] font-semibold text-[#141413] flex items-center gap-1">
                  <ShieldAlert className="w-3.5 h-3.5 text-[#F37021]" />
                  <span>
                    Category Overlap ({preCheckout.duplicateCategoryPieces.length}{' '}
                    on the rail)
                  </span>
                </div>
                {preCheckout.duplicateCategoryPieces.length > 0 ? (
                  <div className="text-[11px] text-[#57534E] space-y-0.5">
                    {preCheckout.duplicateCategoryPieces.map((dup) => (
                      <div key={dup.id} className="truncate font-mono-num">
                        · {dup.code} {dup.brand} (
                        {(dup.wearLogStatus ?? 'verified') === 'verified'
                          ? `${dup.wearsLast60Days}x / 60d`
                          : 'no wear log'}
                        )
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-[11px] text-[#8C857B]">
                    No piece in this category on the rail
                  </div>
                )}
              </div>

              {/* 2. Complete Outfits Unlocked */}
              <div className="p-3 rounded-lg bg-white border border-[#E7E2DA] space-y-1">
                <div className="text-[11px] font-semibold text-[#141413]">
                  3-Piece Outfits Completed (+{preCheckout.unlockedOutfitCount})
                </div>
                <div className="text-[11px] text-[#57534E] font-mono-num space-y-0.5">
                  {preCheckout.unlockedCombinations.map((combo, i) => (
                    <div key={i}>· {combo}</div>
                  ))}
                  {preCheckout.unlockedOutfitCount >
                    preCheckout.unlockedCombinations.length && (
                    <div className="text-[#8C857B]">
                      showing {preCheckout.unlockedCombinations.length} of{' '}
                      {preCheckout.unlockedOutfitCount}
                    </div>
                  )}
                </div>
              </div>

              {/* 3. 1-to-1 Swap Assumption */}
              <div
                className="p-3 rounded-lg bg-[#FFF3EB]/60 border border-[#F37021]/40 space-y-1"
                data-testid="swap-assumption"
              >
                <div className="text-[11px] font-semibold text-[#F37021] flex items-center gap-1">
                  <ArrowRightLeft className="w-3.5 h-3.5" />
                  <span>1:1 Sell-to-Buy Swap (Assumption)</span>
                </div>
                {preCheckout.swapCandidate ? (
                  <div className="text-[11px] text-[#141413] space-y-0.5">
                    <div>
                      If{' '}
                      <strong className="font-mono-num">
                        {preCheckout.swapCandidate.code}
                      </strong>{' '}
                      sold at{' '}
                      {preCheckout.swapCandidateGross !== null ? (
                        <strong className="font-mono-num">
                          {formatCurrency(
                            preCheckout.swapCandidateGross,
                            candidate.currency,
                          )}
                        </strong>
                      ) : (
                        'a price (none on record)'
                      )}{' '}
                      (latest seen)
                    </div>
                    {preCheckout.swapCandidateNetPayout !== null &&
                    preCheckout.netCashAfterSwap !== null ? (
                      <>
                        <div className="text-[#57534E]">
                          Net after checked costs:{' '}
                          <span className="font-mono-num">
                            {formatCurrency(
                              preCheckout.swapCandidateNetPayout,
                              candidate.currency,
                            )}
                          </span>
                        </div>
                        <div className="font-mono-num font-bold text-[#F37021]">
                          Difference to pay:{' '}
                          {formatSignedCurrency(
                            preCheckout.netCashAfterSwap,
                            candidate.currency,
                          )}
                        </div>
                      </>
                    ) : (
                      <div className="text-[#8C857B]">
                        Net unknown (fee not confirmed) · difference not computed
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-[11px] text-[#8C857B]">
                    No piece in the same currency on the rail
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Curated Target Looks List */}
          <div className="space-y-3">
            {looks.map((look) => {
              const status = evaluateTargetLook(look, garments);
              return (
                <div
                  key={look.id}
                  className="p-4 rounded-xl border border-[#E7E2DA] bg-white flex flex-wrap items-center justify-between gap-4"
                >
                  <div>
                    <div className="text-sm font-semibold text-[#141413]">
                      {look.title}
                    </div>
                    <div className="text-xs text-[#57534E] mt-0.5">
                      <span>{look.occasion}</span>
                      <span aria-hidden="true"> · </span>
                      <span className="font-mono-num">
                        {look.pieceIds.join(' + ')}
                      </span>
                    </div>
                    <div className="text-[11px] text-[#8C857B] mt-1 font-mono-num">
                      {status.ownedCount} of {status.totalRequired} pieces on the
                      rail
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      onLockLookForToday(look.pieceIds);
                      onClose();
                    }}
                    className="px-3.5 py-2 rounded-lg text-xs font-semibold bg-[#141413] text-white hover:bg-[#F37021] transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5"
                  >
                    <Check className="w-3.5 h-3.5" />
                    <span>Wear with mine ({look.pieceIds.join(' + ')})</span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

interface AddGarmentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAddGarment: (piece: GarmentPiece) => void;
  nextIndex: number;
  workspaceId?: string | null;
  onScanCloset?: () => void;
}

// Studio shots from the design kit, for trying the photo scan without a photo of your own.
// They run through the same scan as an uploaded photo; pieces hung from them are marked Sample.
const SAMPLE_CAMERA_CAPTURES: {
  id: string;
  label: string;
  frontImageUrl: string;
}[] = [
  {
    id: 'snap-coat',
    label: 'Sample · Coat',
    frontImageUrl: '/src/assets/images/front_cashmere_coat_1793835552741.jpg',
  },
  {
    id: 'snap-blazer',
    label: 'Sample · Blazer',
    frontImageUrl: '/src/assets/images/front_tailored_blazer_1793835553313.jpg',
  },
  {
    id: 'snap-blouson',
    label: 'Sample · Blouson',
    frontImageUrl: '/src/assets/images/front_leather_blouson_1793835550605.jpg',
  },
];

const SILHOUETTE_LABEL: Record<GarmentSilhouette, string> = {
  hoodie: 'Sculpted Hoodie',
  blazer: 'Tailored Blazer',
  overcoat: 'Cashmere Overcoat',
  blouson: 'Leather Blouson',
  knit: 'Cashmere Knit',
  tee: 'Heavyweight Tee',
  trousers: 'Savile Row Trouser Clamp',
  'sneaker-box': '2-Tier Glossy Glass Box',
};

const DEFAULT_SILHOUETTE: GarmentSilhouette = 'hoodie';
const DEFAULT_COLOR = '#F37021';

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('photo could not be read'));
    reader.onerror = () => reject(new Error('photo could not be read'));
    reader.readAsDataURL(file);
  });
}

/**
 * What happened to the chosen photo. 'read' = the scan answered and the form took only what it
 * said (shape, colour, cut-out); 'kept' = no usable scan, the photo is kept as is and nothing
 * was filled in.
 */
type PhotoScanState =
  | { state: 'idle' }
  | { state: 'scanning'; plainUrl: string; fromSample: boolean }
  | {
      state: 'read';
      plainUrl: string;
      fromSample: boolean;
      cutout: string;
      cutoutSource: 'sam-mask' | 'box-crop';
      scanMode: 'live' | 'fake';
      scanReceiptId?: string;
      scanCardId?: string;
      scanColor?: string;
      line: string;
      detail: string;
    }
  | {
      state: 'kept';
      plainUrl: string;
      fromSample: boolean;
      line: string;
    };

export const AddGarmentModal: React.FC<AddGarmentModalProps> = ({
  isOpen,
  onClose,
  onAddGarment,
  nextIndex,
  workspaceId = null,
  onScanCloset,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const scanToken = useRef(0);
  const scanIdentity = useRef({ workspaceId, isOpen });
  scanIdentity.current = { workspaceId, isOpen };
  const [serverMode, setServerMode] = useState<ScanMode | null>(null);
  // True only when this app's server itself answered the status check (not a network fallback).
  const [statusFromServer, setStatusFromServer] = useState(false);
  const [photo, setPhoto] = useState<PhotoScanState>({ state: 'idle' });
  // Silhouette, category and colour the scan filled in (so a new photo can undo them).
  const [scanPrefilled, setScanPrefilled] = useState(false);
  const [scannedColor, setScannedColor] = useState<{
    name: string;
    hex: string;
  } | null>(null);
  const [pasteNote, setPasteNote] = useState('');

  const [quickLine, setQuickLine] = useState('');
  const [name, setName] = useState('');
  const [brand, setBrand] = useState('');
  const [silhouette, setSilhouette] =
    useState<GarmentSilhouette>(DEFAULT_SILHOUETTE);
  const [category, setCategory] = useState<GarmentCategory | null>(null);
  const [currency, setCurrency] = useState<CurrencyCode>('KRW');
  const [price, setPrice] = useState('');
  const [platform, setPlatform] = useState<ResalePlatform>('KREAM');
  // The typed price is an asking price seen unless the owner marks it as a trade or as paid.
  const [priceKind, setPriceKind] = useState<'listed' | 'traded' | 'paid'>(
    'listed',
  );
  const [colorHex, setColorHex] = useState(DEFAULT_COLOR);
  const [occlusionStatus, setOcclusionStatus] = useState<
    'front_verified' | 'side_occluded'
  >('front_verified');
  const [error, setError] = useState('');

  useEffect(() => {
    scanToken.current++;
    setPhoto({ state: 'idle' }); setScanPrefilled(false); setScannedColor(null);
    setSilhouette(DEFAULT_SILHOUETTE); setCategory(null); setColorHex(DEFAULT_COLOR);
    return () => { scanToken.current++; };
  }, [workspaceId, isOpen]);

  // Which server answers the scan (live Meta models, the test fake, or none): shown as is.
  useEffect(() => {
    if (!isOpen) return;
    let gone = false;
    fetch('/api/scan/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (gone) return;
        const answered = !!j && typeof j.mode === 'string';
        setStatusFromServer(answered);
        setServerMode(answered ? (j.mode as ScanMode) : 'no_key');
      })
      .catch(() => {
        if (gone) return;
        setStatusFromServer(false);
        setServerMode('no_key');
      });
    return () => {
      gone = true;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const platformOptions = platformsForCurrency(currency);

  const handleCurrencyChange = (next: CurrencyCode) => {
    setCurrency(next);
    const allowed = platformsForCurrency(next);
    if (!allowed.some((p) => p.name === platform)) {
      setPlatform(allowed[0]?.name ?? (next === 'USD' ? 'Grailed' : 'KREAM'));
    }
  };

  const undoScanPrefill = () => {
    if (!scanPrefilled) return;
    setSilhouette(DEFAULT_SILHOUETTE);
    setCategory(null);
    setColorHex(DEFAULT_COLOR);
    setScannedColor(null);
    setScanPrefilled(false);
  };

  /**
   * One photo -> POST /api/scan (mode 'outfit', empty sentence). On success the form takes ONLY
   * what the scan says: the first hangable card's shape and colour, and its cut-out as the image.
   * Brand, name and price stay empty. On any failure the photo is kept as is and nothing is filled.
   */
  const scanPhotoFile = async (file: File, fromSample: boolean) => {
    const token = ++scanToken.current;
    const current = () => token === scanToken.current && scanIdentity.current.isOpen && scanIdentity.current.workspaceId === workspaceId;
    undoScanPrefill();
    setError('');
    let plainUrl = '';
    try {
      plainUrl = await readAsDataUrl(file);
    } catch {
      if (!current()) return;
      setPhoto({ state: 'idle' });
      setError('The photo could not be read.');
      return;
    }
    if (!current()) return;

    if (samplePreviewOnly(fromSample, workspaceId)) {
      setPhoto({ state: 'kept', plainUrl, fromSample, line: 'Sample preview only · no Meta call. Choose your own photo to scan and save to your wardrobe.' });
      return;
    }

    if (!workspaceId && serverMode !== 'fake') {
      setPhoto({ state: 'kept', plainUrl, fromSample, line: 'Photo kept as is · sign in to scan with Meta and save to your wardrobe.' });
      return;
    }

    // The server already said it cannot scan: keep the photo without sending it.
    if (statusFromServer && (serverMode === 'no_key' || serverMode === 'off')) {
      setPhoto({
        state: 'kept',
        plainUrl,
        fromSample,
        line: `Photo kept as is · no model call (${
          serverMode === 'off'
            ? 'META_DISABLED: model calls are switched off on this server'
            : 'META_KEY_MISSING: no Meta key on this server'
        })`,
      });
      return;
    }
    setPhoto({ state: 'scanning', plainUrl, fromSample });

    let status = 0;
    let body: ScanOk | ScanFail | null = null;
    let networkError = '';
    try {
      const { jpeg, png } = await prepare(file);
      if (!current()) return;
      const res = await fetch('/api/scan', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          jpegBase64: jpeg,
          pngBase64: png,
          sentence: '',
          mode: 'outfit',
        }),
      });
      status = res.status;
      body = (await res.json().catch(() => null)) as ScanOk | ScanFail | null;
    } catch (e) {
      networkError = e instanceof Error ? e.message : String(e);
    }
    if (!current()) return; // A newer photo or account superseded this result.

    const keep = (reason: string, modelAnswered: boolean | null) => {
      setPhoto({
        state: 'kept',
        plainUrl,
        fromSample,
        line: `Photo kept as is · ${modelAnswered === null ? 'scan outcome unknown' : modelAnswered ? 'scan attempted; result not used' : 'no model call'} (${reason})`,
      });
    };

    if (!body || !body.ok || status < 200 || status >= 300) {
      if (body && !body.ok) {
        keep(`${body.code}: ${body.detail}`, scanAttempted(body));
      } else if (networkError) {
        keep(`NETWORK: ${networkError}`, null);
      } else {
        keep(`HTTP ${status}: no scan result`, null);
      }
      return;
    }

    const card = body.cards.find((c) => SHAPE[c.type]);
    const live = body.mode === 'live';
    if (live && (!body.receiptId || !/^[A-Za-z0-9_-]{1,128}$/.test(body.receiptId))) {
      keep('SCAN_RECEIPT_MISSING: the result could not be verified', true);
      return;
    }
    if (!card) {
      keep(
        `NO_GARMENT: the scan found ${plural(body.cards.length, 'card')} but none that hangs on the rail`,
        live,
      );
      return;
    }

    const [sil, cat] = SHAPE[card.type];
    const colorName = card.maskColor ?? card.sparkColor;
    const hex = NAMED_HEX[colorName] ?? NAMED_HEX.unknown;
    const cutoutSource = card.cutoutKind === 'mask' ? 'sam-mask' : 'box-crop';
    const line = live
      ? cutoutSource === 'sam-mask'
        ? 'Read by Muse Spark + SAM 3.1 · LIVE'
        : 'Read by Muse Spark · SAM 3.1 mask not used (box crop) · LIVE'
      : 'Test fake · no Meta call';
    const others = body.cards.length - 1;
    const detail = `Filled in from the scan: ${card.type.replace(/_/g, ' ')} → ${SILHOUETTE_LABEL[sil]} shape · colour ${colorName} (${card.maskColor ? 'mask pixels' : 'Spark'})${others > 0 ? ` · ${plural(others, 'other card')} not used` : ''}. Brand, name and price are yours to type.`;

    setSilhouette(sil);
    setCategory(cat);
    setColorHex(hex);
    setScannedColor({ name: colorName, hex });
    setScanPrefilled(true);
    setPhoto({
      state: 'read',
      plainUrl,
      fromSample,
      cutout: card.cutout,
      cutoutSource,
      scanMode: live ? 'live' : 'fake',
      ...(live ? { scanReceiptId: body.receiptId, scanCardId: String(card.cardId), scanColor: colorName } : {}),
      line,
      detail,
    });
  };

  // Handle real user photo upload via <input type="file">
  const handlePhotoFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    void scanPhotoFile(file, false);
  };

  // A design-kit studio shot goes through the same scan; the piece is marked Sample.
  const handleSelectSampleCapture = async (
    sample: (typeof SAMPLE_CAMERA_CAPTURES)[number],
  ) => {
    try {
      const blob = await (await fetch(sample.frontImageUrl)).blob();
      const file = new File([blob], `${sample.id}.jpg`, {
        type: blob.type || 'image/jpeg',
      });
      await scanPhotoFile(file, true);
    } catch {
      setError('The sample photo could not be loaded.');
    }
  };

  const handleApplyQuickPaste = () => {
    const parsed = parseQuickOrderLine(quickLine);
    if (!parsed) {
      setError(
        'Could not find a price in the line (e.g. SSENSE Lemaire Coat ₩2,450,000)',
      );
      return;
    }
    if (parsed.brand) setBrand(parsed.brand);
    if (parsed.name) setName(parsed.name);
    handleCurrencyChange(parsed.currency);
    setPrice(String(parsed.price));
    setPriceKind('paid');
    if (parsed.silhouette) {
      setSilhouette(parsed.silhouette);
      setCategory(null);
    }
    setPasteNote(
      `Read from your line (no model call): ${[
        parsed.brand || 'no brand',
        parsed.name || 'no name',
        `${formatCurrency(parsed.price, parsed.currency)} as what you paid`,
      ].join(' · ')}`,
    );
    setError('');
  };

  const resetForm = () => {
    scanToken.current += 1;
    setPhoto({ state: 'idle' });
    setScanPrefilled(false);
    setScannedColor(null);
    setPasteNote('');
    setQuickLine('');
    setName('');
    setBrand('');
    setPrice('');
    setPriceKind('listed');
    setSilhouette(DEFAULT_SILHOUETTE);
    setCategory(null);
    setColorHex(DEFAULT_COLOR);
    setError('');
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (photo.state === 'scanning') {
      setError('Wait for the scan to finish.');
      return;
    }
    if (photo.state !== 'idle' && samplePreviewOnly(photo.fromSample, workspaceId)) {
      setError('This sample is a preview only. Choose your own photo to save a personal piece.');
      return;
    }
    if (!name.trim()) {
      setError('Type a name for the piece (brand and price are optional).');
      return;
    }
    const priceText = price.replace(/,/g, '').trim();
    let numericPrice: number | null = null;
    if (priceText) {
      numericPrice = Number(priceText);
      if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
        setError('Enter a positive price, or leave it empty.');
        return;
      }
    }
    if (
      numericPrice !== null &&
      priceKind !== 'paid' &&
      !platformsForCurrency(currency).some((p) => p.name === platform)
    ) {
      setError(`${platform} is not a ${currency} platform. Pick one from the list.`);
      return;
    }

    const stamp = Date.now();
    const scanned = photo.state === 'read';
    // Only what was typed or read by the scan: at most one price (no default), default fees NOT
    // confirmed, no wear log, no decision, no condition grade, no fabric.
    const newPiece: GarmentPiece = createHungPiece({
      // Scanned pieces use the "scan-" id so this browser keeps them after a reload.
      id: scanned ? `scan-upload-${stamp}` : `piece-custom-${stamp}`,
      observationId: `obs-${stamp}`,
      code: `A${nextIndex}`,
      name,
      brand,
      silhouette,
      category: category ?? undefined,
      currency,
      price: numericPrice,
      platform,
      priceKind,
      colorHex,
      occlusionStatus,
      imageUrl:
        photo.state === 'read'
          ? photo.cutout
          : photo.state === 'kept'
            ? photo.plainUrl
            : undefined,
      cutoutSource: photo.state === 'read' ? photo.cutoutSource : undefined,
      scanMode: photo.state === 'read' ? photo.scanMode : undefined,
      isSample: photo.state !== 'idle' && photo.fromSample,
    });

    if (photo.state === 'read' && photo.scanReceiptId) {
      newPiece.scanReceiptId = photo.scanReceiptId;
      newPiece.scanCardId = photo.scanCardId;
      newPiece.scanColor = photo.scanColor;
    }
    onAddGarment(newPiece);
    resetForm();
    onClose();
  };

  const swatches = [
    { label: 'Hermès Orange', hex: '#F37021' },
    { label: 'Obsidian', hex: '#232426' },
    { label: 'Midnight Navy', hex: '#18202C' },
    { label: 'Camel Cashmere', hex: '#C8AE8D' },
    { label: 'Racing Green', hex: '#183C28' },
    { label: 'Heather Ash', hex: '#9FA3A7' },
  ];

  const previewUrl =
    photo.state === 'read'
      ? photo.cutout
      : photo.state === 'kept' || photo.state === 'scanning'
        ? photo.plainUrl
        : null;
  const showStep2 = photo.state !== 'idle' || pasteNote !== '';
  const priceShown = (() => {
    const n = Number(price.replace(/,/g, '').trim());
    if (!price.trim() || !Number.isFinite(n) || n <= 0) return 'Price not set';
    return `${formatCurrency(n, currency)} ${
      priceKind === 'paid' ? '(paid)' : priceKind === 'traded' ? '(trade seen)' : '(ask seen)'
    }`;
  })();

  return (
    <div
      className="fixed inset-0 z-40 bg-black/25 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Upload Garment Photo and Hang on Boutique Rail"
    >
      <div className="bg-white border border-[#E7E2DA] rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto p-6 shadow-2xl">
        <div className="flex items-center justify-between pb-3.5 border-b border-[#E7E2DA]">
          <div>
            <h2 className="text-lg font-display font-semibold text-[#141413]">
              Upload Photo &amp; Hang Piece on 3D Rail
            </h2>
            <p className="text-xs text-[#8C857B]">
              Step 1: Upload 1 photo → Step 2: Check what the scan filled in, then
              type the rest
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close add piece modal"
            className="p-1.5 rounded-lg text-[#57534E] hover:text-[#141413]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {workspaceId && onScanCloset && (
          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <button
              type="button"
              onClick={onScanCloset}
              data-testid="open-closet-scan"
              className="min-h-9 font-semibold text-[#B8460F] underline underline-offset-2"
            >
              Scan a closet photo
            </button>
            <span className="text-[#8C857B]">Find and review multiple pieces in one photo.</span>
          </div>
        )}

        {/* STEP 1: PHOTO UPLOAD FILE INPUT & SAMPLE STUDIO PHOTOS */}
        <div className="mt-4 p-3.5 rounded-xl bg-[#FFF3EB]/60 border border-[#F37021]/40 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
            <span className="text-xs font-semibold text-[#141413] flex items-center gap-1.5">
              <Camera className="w-4 h-4 text-[#F37021]" />
              <span>Step 1 · Upload a Garment Photo (Scan Fills Shape &amp; Colour)</span>
            </span>
            <span
              className="text-[10px] font-mono-num text-[#F37021] font-semibold"
              data-testid="upload-scan-server-mode"
            >
              {serverMode === 'live' && !workspaceId ? 'Sign in for Meta scanning · manual photo entry is available' : modeLine(serverMode)}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              id="garment-photo-upload-input"
              data-testid="garment-photo-upload-input"
              type="file"
              accept="image/*"
              onChange={handlePhotoFileChange}
              className="block w-full text-xs text-[#57534E] file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-[#F37021] file:text-white hover:file:bg-[#D95D12] cursor-pointer bg-white border border-[#E7E2DA] rounded-lg p-1"
            />
          </div>

          {/* Private wardrobes preview design-kit samples without making a paid request. */}
          <div className="space-y-1">
            <div className="text-[10px] text-[#8C857B]">
              Or preview a design-kit sample photo (samples stay outside your personal wardrobe):
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {SAMPLE_CAMERA_CAPTURES.map((sample) => (
                <button
                  key={sample.id}
                  type="button"
                  data-testid={`sample-photo-${sample.id}`}
                  onClick={() => void handleSelectSampleCapture(sample)}
                  className="p-1.5 rounded-lg bg-white border border-[#E7E2DA] hover:border-[#F37021] text-left flex items-center gap-1.5 transition-colors min-w-0"
                >
                  <img
                    src={sample.frontImageUrl}
                    alt={sample.label}
                    className="w-7 h-7 rounded object-contain bg-[#FAF8F5] shrink-0"
                  />
                  <span className="text-[10px] font-medium text-[#141413] leading-tight truncate">
                    {sample.label}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* STEP 2: CHECK WHAT THE SCAN (OR YOUR LINE) FILLED IN BEFORE HANGING */}
        {showStep2 && (
          <div
            className="mt-3 p-3 rounded-xl bg-[#FAF8F5] border-2 border-[#F37021] space-y-2.5"
            data-testid="photo-analysis-confirmation-step"
          >
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
              <span className="text-xs font-bold text-[#F37021] flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5" />
                <span>Step 2 · Check Before Hanging</span>
              </span>
              <span
                className="text-[10px] font-mono-num px-1.5 py-0.5 rounded bg-white border border-[#F37021]/30 text-[#141413]"
                data-testid="upload-scan-state"
              >
                {photo.state === 'scanning'
                  ? 'Reading the photo…'
                  : photo.state === 'read'
                    ? photo.scanMode === 'live'
                      ? 'Scan read · LIVE'
                      : 'Scan read · test fake'
                    : photo.state === 'kept'
                      ? 'Photo only'
                      : 'From your line'}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {previewUrl && (
                <div className="w-14 h-16 rounded-lg bg-[repeating-conic-gradient(#F3F0EA_0%_25%,#FFFFFF_0%_50%)] bg-[length:12px_12px] border border-[#E7E2DA] overflow-hidden shrink-0 flex items-center justify-center">
                  <img
                    src={previewUrl}
                    alt={
                      photo.state === 'read'
                        ? 'Cut-out from the scan'
                        : 'Your photo, kept as is'
                    }
                    className="w-full h-full object-contain p-1"
                    data-testid="upload-preview"
                  />
                </div>
              )}
              <div className="text-[11px] text-[#57534E] leading-snug flex-1 min-w-[180px]">
                <div className="font-semibold text-[#141413] truncate">
                  {brand.trim() || 'Brand not entered'} ·{' '}
                  {name.trim() || 'Name not entered'} · {priceShown}
                </div>
                {photo.state === 'scanning' && (
                  <div className="text-[10px] text-[#8C857B] mt-0.5 inline-flex items-center gap-1">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Sending the photo to this app's server for a scan…
                  </div>
                )}
                {(photo.state === 'read' || photo.state === 'kept') && (
                  <div
                    className="text-[10px] font-mono-num text-[#141413] mt-0.5"
                    data-testid="upload-scan-line"
                  >
                    {photo.line}
                  </div>
                )}
                {photo.state === 'read' && (
                  <div
                    className="text-[10px] text-[#8C857B] mt-0.5"
                    data-testid="upload-scan-detail"
                  >
                    {photo.detail}
                  </div>
                )}
                {photo.state === 'kept' && (
                  <div className="text-[10px] text-[#8C857B] mt-0.5">
                    Nothing was filled in from the photo. Shape, colour, brand,
                    name and price are yours to set.
                  </div>
                )}
                {photo.state !== 'idle' && photo.fromSample && (
                  <div className="text-[10px] text-[#8C857B] mt-0.5">
                    Sample photo from the design kit: the piece is marked Sample.
                  </div>
                )}
                {pasteNote && (
                  <div className="text-[10px] text-[#8C857B] mt-0.5">
                    {pasteNote}
                  </div>
                )}
              </div>
              <button
                type="button"
                data-testid="confirm-hang-photo-btn"
                disabled={photo.state === 'scanning'}
                onClick={() => {
                  const fakeEvent = {
                    preventDefault: () => {},
                  } as React.FormEvent;
                  handleSubmit(fakeEvent);
                }}
                className="ml-auto px-3 py-2 text-xs font-semibold bg-[#F37021] text-white rounded-lg hover:bg-[#D95D12] transition-colors shrink-0 inline-flex items-center gap-1.5 shadow-sm disabled:opacity-50"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>Confirm &amp; Hang</span>
              </button>
            </div>
          </div>
        )}

        {/* Optional Zero-CSV 1-Line Order Paste Onboarding (parsed by code, no model call) */}
        <div className="mt-3 p-2.5 rounded-xl bg-[#FAF8F5] border border-[#E7E2DA] space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-[#141413] flex items-center gap-1">
              <ClipboardPaste className="w-3.5 h-3.5 text-[#F37021]" />
              <span>Or Paste 1-Line Order Receipt (Zero-CSV)</span>
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              data-testid="quick-order-paste-input"
              value={quickLine}
              onChange={(e) => setQuickLine(e.target.value)}
              placeholder="e.g. SSENSE Lemaire Double Coat ₩2,450,000"
              className="flex-1 min-w-0 px-2.5 py-1.5 text-xs bg-white border border-[#E7E2DA] rounded-lg text-[#141413]"
            />
            <button
              type="button"
              data-testid="quick-order-parse-btn"
              onClick={handleApplyQuickPaste}
              className="px-2.5 py-1.5 text-[11px] font-semibold bg-[#141413] text-white rounded-lg hover:bg-[#F37021] transition-colors whitespace-nowrap"
            >
              Fill From Line
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3 mt-3.5">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label
                htmlFor="add-brand"
                className="block text-xs font-medium text-[#57534E] mb-1"
              >
                Brand (optional)
              </label>
              <input
                id="add-brand"
                type="text"
                placeholder="HERMÈS / LEMAIRE"
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-[#E7E2DA] rounded-lg"
              />
            </div>
            <div>
              <label
                htmlFor="add-silhouette"
                className="block text-xs font-medium text-[#57534E] mb-1"
              >
                3D Silhouette{scanPrefilled ? ' (from scan)' : ''}
              </label>
              <select
                id="add-silhouette"
                value={silhouette}
                onChange={(e) => {
                  setSilhouette(e.target.value as GarmentSilhouette);
                  setCategory(null);
                }}
                className="w-full px-3 py-2 text-xs border border-[#E7E2DA] rounded-lg bg-white"
              >
                <option value="hoodie">Sculpted Hoodie</option>
                <option value="blazer">Tailored Blazer</option>
                <option value="overcoat">Cashmere Overcoat</option>
                <option value="blouson">Leather Blouson</option>
                <option value="knit">Cashmere Knit</option>
                <option value="tee">Heavyweight Tee</option>
                <option value="trousers">Tailored Pleated Trousers</option>
                <option value="sneaker-box">Glossy Glass Shoe Vitrine</option>
              </select>
            </div>
          </div>

          <div>
            <label
              htmlFor="add-name"
              className="block text-xs font-medium text-[#57534E] mb-1"
            >
              Garment Name
            </label>
            <input
              id="add-name"
              type="text"
              placeholder="Double-Faced Wool Overshirt"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 text-xs border border-[#E7E2DA] rounded-lg"
            />
          </div>

          <div className="grid grid-cols-3 gap-2.5">
            <div>
              <label
                htmlFor="add-currency"
                className="block text-xs font-medium text-[#57534E] mb-1"
              >
                Currency
              </label>
              <select
                id="add-currency"
                value={currency}
                onChange={(e) =>
                  handleCurrencyChange(e.target.value as CurrencyCode)
                }
                className="w-full px-2.5 py-2 text-xs border border-[#E7E2DA] rounded-lg bg-white"
              >
                <option value="KRW">KRW (₩)</option>
                <option value="USD">USD ($)</option>
              </select>
            </div>
            <div>
              <label
                htmlFor="add-platform"
                className="block text-xs font-medium text-[#57534E] mb-1"
              >
                Platform
              </label>
              <select
                id="add-platform"
                value={platform}
                onChange={(e) => setPlatform(e.target.value as ResalePlatform)}
                className="w-full px-2.5 py-2 text-xs border border-[#E7E2DA] rounded-lg bg-white"
              >
                {platformOptions.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor="add-price"
                className="block text-xs font-medium text-[#57534E] mb-1"
              >
                Price (optional)
              </label>
              <input
                id="add-price"
                type="number"
                step="any"
                placeholder="not set"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                className="w-full px-3 py-2 text-xs font-mono-num border border-[#E7E2DA] rounded-lg"
              />
            </div>
          </div>

          {/* Price kind: an ask unless the owner says it was a trade or what they paid */}
          <div data-testid="price-kind-toggle">
            <span className="block text-xs font-medium text-[#57534E] mb-1">
              This price is (default: an ask you saw)
            </span>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  { id: 'listed', label: '○ Ask Seen (ASK)' },
                  { id: 'traded', label: '● Trade Seen (TRADE)' },
                  { id: 'paid', label: 'What I Paid' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setPriceKind(opt.id)}
                  className={`py-1.5 px-2 rounded-lg border text-[11px] font-medium transition-colors ${
                    priceKind === opt.id
                      ? opt.id === 'traded'
                        ? 'bg-[#F37021] text-white border-[#F37021]'
                        : 'bg-[#141413] text-white border-[#141413]'
                      : 'bg-white text-[#57534E] border-[#E7E2DA]'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-[#8C857B] mt-1">
              The piece hangs with fees not confirmed, no wear log and no Keep/Sell
              decision. With no price, the ask stays “not set”.
            </p>
          </div>

          {/* Photo angle: a manual choice (no model checks the angle) */}
          <div data-testid="occlusion-honesty-toggle">
            <span className="block text-xs font-medium text-[#57534E] mb-1">
              Photo Angle (Your Choice · No Model Call)
            </span>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setOcclusionStatus('front_verified')}
                className={`py-1.5 px-2.5 rounded-lg border text-[11px] font-medium transition-colors ${
                  occlusionStatus === 'front_verified'
                    ? 'bg-[#141413] text-white border-[#141413]'
                    : 'bg-white text-[#57534E] border-[#E7E2DA]'
                }`}
              >
                Front (3D Cutout)
              </button>
              <button
                type="button"
                onClick={() => setOcclusionStatus('side_occluded')}
                className={`py-1.5 px-2.5 rounded-lg border text-[11px] font-medium transition-colors ${
                  occlusionStatus === 'side_occluded'
                    ? 'bg-[#F37021] text-white border-[#F37021]'
                    : 'bg-white text-[#57534E] border-[#E7E2DA]'
                }`}
              >
                Side / Occluded (Keep 2D Card)
              </button>
            </div>
          </div>

          <div>
            <span className="block text-xs font-medium text-[#57534E] mb-1.5">
              Garment Dye Swatch
              {scannedColor ? ` (scan: ${scannedColor.name})` : ''}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              {scannedColor && (
                <button
                  type="button"
                  onClick={() => setColorHex(scannedColor.hex)}
                  aria-label={`Colour from the scan: ${scannedColor.name}`}
                  data-testid="scanned-color-swatch"
                  className={`w-7 h-7 rounded-full border-2 transition-transform ${
                    colorHex === scannedColor.hex
                      ? 'border-[#141413] scale-110'
                      : 'border-transparent'
                  }`}
                  style={{ backgroundColor: scannedColor.hex }}
                />
              )}
              {swatches.map((s) => (
                <button
                  key={s.hex}
                  type="button"
                  onClick={() => setColorHex(s.hex)}
                  aria-label={s.label}
                  className={`w-7 h-7 rounded-full border-2 transition-transform ${
                    colorHex === s.hex
                      ? 'border-[#141413] scale-110'
                      : 'border-transparent'
                  }`}
                  style={{ backgroundColor: s.hex }}
                />
              ))}
            </div>
          </div>

          {error && (
            <p className="text-xs text-red-600 font-medium" role="alert">
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-[#57534E] hover:text-[#141413]"
            >
              Cancel
            </button>
            <button
              type="submit"
              data-testid="confirm-hang-piece-btn"
              disabled={photo.state === 'scanning' || (photo.state !== 'idle' && samplePreviewOnly(photo.fromSample, workspaceId))}
              className="px-5 py-2 text-xs font-semibold bg-[#F37021] text-white rounded-lg hover:bg-[#D95D12] transition-colors inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>
                {showStep2 ? 'Confirm & Hang on 3D Rail' : 'Hang on 3D Rail'}
              </span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
