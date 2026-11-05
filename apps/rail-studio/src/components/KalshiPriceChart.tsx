import React, { useState } from 'react';
import { CurrencyCode, GarmentPiece, PriceObservation } from '../types/closet';
import {
  buildPlatformDotStrips,
  filterObservationsByWindow,
  formatCurrency,
  plural,
  REFERENCE_DATE,
} from '../utils/ledgerLogic';

interface KalshiPriceChartProps {
  garment?: GarmentPiece;
  observations: PriceObservation[];
  currency: CurrencyCode;
  window: '30d' | '90d' | 'all';
  onWindowChange: (w: '30d' | '90d' | 'all') => void;
  purchasePrice: number | null;
  /** The ask being looked at; null when the piece has no price on record (no default ask). */
  simulatedAskPrice?: number | null;
  tradedBandMin?: number | null;
  tradedBandMax?: number | null;
  /** Number of trade prices behind tradedBandMin..tradedBandMax. */
  tradedCount?: number | null;
  excludedObsIds?: string[];
  onToggleExcludeObs?: (obsId: string) => void;
}

const TRAJECTORY_PLATFORM_COLORS = [
  '#F37021',
  '#141413',
  '#C5A572',
  '#57534E',
  '#8C857B',
];

const kindWord = (kind: 'traded' | 'listed', count = 1) =>
  kind === 'traded' ? (count === 1 ? 'trade' : 'trades') : count === 1 ? 'ask' : 'asks';

export const KalshiPriceChart: React.FC<KalshiPriceChartProps> = ({
  garment,
  observations,
  currency,
  window,
  onWindowChange,
  purchasePrice,
  simulatedAskPrice = null,
  tradedBandMin = null,
  tradedBandMax = null,
  tradedCount = null,
  excludedObsIds = [],
  onToggleExcludeObs,
}) => {
  const [chartMode, setChartMode] = useState<'dot-strip' | 'trajectory'>(
    'dot-strip',
  );

  const activeObservations = observations.filter(
    (o) => !excludedObsIds.includes(o.id),
  );

  const { filtered, latest, first, seriesCount, deltaAmount, deltaPct } =
    filterObservationsByWindow(
      activeObservations.length > 0 ? activeObservations : observations,
      currency,
      window,
      REFERENCE_DATE,
    );

  const width = 460;
  const height = 168;
  const padX = 20;
  const padY = 24;

  const prices = filtered.map((o) => o.price);
  if (purchasePrice && purchasePrice > 0) {
    prices.push(purchasePrice);
  }
  if (simulatedAskPrice && simulatedAskPrice > 0) {
    prices.push(simulatedAskPrice);
  }

  const minPrice = prices.length > 0 ? Math.min(...prices) * 0.91 : 0;
  const maxPrice = prices.length > 0 ? Math.max(...prices) * 1.09 : 100;
  const range = Math.max(1, maxPrice - minPrice);

  const priceToY = (p: number) =>
    height - padY - ((p - minPrice) / range) * (height - padY * 2);

  const points = filtered.map((obs, idx) => {
    const x =
      filtered.length === 1
        ? width / 2
        : padX + (idx / (filtered.length - 1)) * (width - padX * 2);
    const y = priceToY(obs.price);
    return { x, y, obs };
  });

  // Date labels: only where they fit (at least LABEL_GAP px apart), the latest always shown.
  // Every point keeps its own tooltip with date, platform and kind.
  const LABEL_GAP = 110;
  const labelled = new Set<number>();
  let lastLabelX = -Infinity;
  points.forEach((pt, i) => {
    if (pt.x - lastLabelX >= LABEL_GAP) {
      labelled.add(i);
      lastLabelX = pt.x;
    }
  });
  const lastIndex = points.length - 1;
  if (lastIndex >= 0 && !labelled.has(lastIndex)) {
    const prev = [...labelled].pop();
    if (prev !== undefined && points[lastIndex].x - points[prev].x < LABEL_GAP) labelled.delete(prev);
    labelled.add(lastIndex);
  }

  // One line per platform (never one line joining different platforms).
  const platformsInView: string[] = [];
  for (const p of points) {
    if (!platformsInView.includes(p.obs.platform)) {
      platformsInView.push(p.obs.platform);
    }
  }
  const platformColor = (platform: string) =>
    TRAJECTORY_PLATFORM_COLORS[
      Math.max(0, platformsInView.indexOf(platform)) %
        TRAJECTORY_PLATFORM_COLORS.length
    ];
  const platformLines = platformsInView
    .map((platform) => ({
      platform,
      pts: points.filter((p) => p.obs.platform === platform),
    }))
    .filter((l) => l.pts.length > 1)
    .map((l) => ({
      platform: l.platform,
      polyline: l.pts.map((p) => `${p.x},${p.y}`).join(' '),
    }));

  const purchaseY =
    purchasePrice && purchasePrice > 0 ? priceToY(purchasePrice) : null;

  const askY =
    simulatedAskPrice && simulatedAskPrice > 0
      ? priceToY(simulatedAskPrice)
      : null;

  const bandTopY =
    tradedBandMax && tradedBandMax > 0 ? priceToY(tradedBandMax) : null;
  const bandBottomY =
    tradedBandMin && tradedBandMin > 0 ? priceToY(tradedBandMin) : null;

  const isPositive = (deltaAmount ?? 0) >= 0;

  // Build Per-Platform Dot Strips when garment is provided. With no ask (no price on record),
  // no net payout is computed for any row.
  const dotStripRows = garment
    ? buildPlatformDotStrips(
        garment,
        simulatedAskPrice && simulatedAskPrice > 0 ? simulatedAskPrice : null,
        excludedObsIds,
      )
    : [];

  // Global horizontal axis scale for Dot-Strip view
  const allDotPrices: number[] = [];
  observations
    .filter((o) => o.currency === currency && o.price > 0)
    .forEach((o) => allDotPrices.push(o.price));
  if (simulatedAskPrice && simulatedAskPrice > 0) {
    allDotPrices.push(simulatedAskPrice);
  }
  const stripMin =
    allDotPrices.length > 0 ? Math.min(...allDotPrices) * 0.92 : 0;
  const stripMax =
    allDotPrices.length > 0 ? Math.max(...allDotPrices) * 1.08 : 100;
  const stripSpan = Math.max(1, stripMax - stripMin);
  const priceToPct = (p: number) =>
    Math.max(4, Math.min(96, ((p - stripMin) / stripSpan) * 92 + 4));

  // The star is only ever placed among rows whose fees the owner actually confirmed.
  const confirmedRowCount = dotStripRows.filter((r) => r.feeConfirmed).length;

  return (
    <div
      className="border border-[#E7E2DA] bg-[#FAF8F5] p-4 rounded-xl space-y-3"
      data-testid="kalshi-price-chart"
    >
      {/* Top metric row + Chart Mode Switcher */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-medium text-[#8C857B] tracking-wide">
            PER-PLATFORM PRICES &amp; TRAJECTORY · ON RECORD ({currency})
          </div>
          <div className="flex flex-wrap items-baseline gap-x-2.5 mt-0.5">
            <span className="text-2xl font-semibold font-mono-num text-[#141413]">
              {latest ? formatCurrency(latest.price, currency) : 'No price on record'}
            </span>
            {deltaAmount !== null && latest ? (
              <span
                className={`text-xs font-mono-num font-medium whitespace-nowrap ${
                  isPositive ? 'text-[#F37021]' : 'text-[#57534E]'
                }`}
                title={`Change from the first of ${seriesCount} ${latest.platform} ${kindWord(latest.kind, seriesCount)} on record`}
                data-testid="same-series-delta"
              >
                {deltaAmount >= 0 ? '+' : '−'}
                {formatCurrency(Math.abs(deltaAmount), currency)}
                {deltaPct !== null
                  ? ` (${deltaPct >= 0 ? '+' : ''}${deltaPct}%)`
                  : ''}
              </span>
            ) : latest ? (
              <span
                className="text-[10px] font-mono-num text-[#8C857B]"
                data-testid="same-series-delta"
              >
                Change: {seriesCount} {latest.platform}{' '}
                {kindWord(latest.kind, seriesCount)} on record
              </span>
            ) : null}
          </div>
          {latest && (
            <div className="text-[11px] text-[#57534E] mt-0.5 flex flex-wrap items-center gap-1.5">
              <span>
                {latest.platform}
                {latest.isSample ? ' · Sample' : ''}
              </span>
              <span aria-hidden="true">·</span>
              <span>
                {latest.kind === 'traded'
                  ? '● Completed Trade (TRADE)'
                  : '○ Active Listing (ASK)'}
              </span>
              <span aria-hidden="true">·</span>
              <span>As of {latest.date}</span>
              {deltaAmount !== null && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-[#8C857B]">
                    change vs {seriesCount} same-platform{' '}
                    {kindWord(latest.kind, seriesCount)}
                  </span>
                </>
              )}
            </div>
          )}
        </div>

        {/* Mode Switcher: Dot Strip vs Trajectory */}
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <div
            className="flex items-center bg-white border border-[#E7E2DA] rounded-lg p-0.5"
            role="group"
            aria-label="Chart visualization mode"
          >
            <button
              type="button"
              data-testid="mode-dot-strip"
              onClick={() => setChartMode('dot-strip')}
              className={`px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors whitespace-nowrap ${
                chartMode === 'dot-strip'
                  ? 'bg-[#141413] text-white'
                  : 'text-[#57534E] hover:text-[#141413]'
              }`}
            >
              Platform Dot Strip
            </button>
            <button
              type="button"
              data-testid="mode-trajectory"
              onClick={() => setChartMode('trajectory')}
              className={`px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors whitespace-nowrap ${
                chartMode === 'trajectory'
                  ? 'bg-[#F37021] text-white'
                  : 'text-[#57534E] hover:text-[#141413]'
              }`}
            >
              Time Trajectory
            </button>
          </div>

          {chartMode === 'trajectory' && (
            <div
              className="flex items-center bg-white border border-[#E7E2DA] rounded-lg p-0.5"
              role="group"
              aria-label="Chart timeframe"
            >
              {(['30d', '90d', 'all'] as const).map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => onWindowChange(w)}
                  className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors whitespace-nowrap ${
                    window === w
                      ? 'bg-[#F37021] text-white'
                      : 'text-[#57534E] hover:text-[#141413]'
                  }`}
                >
                  {w.toUpperCase()}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* MODE 1: PER-PLATFORM DOT & RANGE STRIP GRAPH (ASK vs TRADE Separation + Per-Platform Net If Sold + 1-Tap Outlier Exclusion) */}
      {chartMode === 'dot-strip' && dotStripRows.length > 0 ? (
        <div
          className="space-y-2.5 pt-1"
          data-testid="platform-dot-strip-chart"
        >
          {/* Legend Row */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-[#57534E] bg-white px-2.5 py-1.5 rounded-lg border border-[#E7E2DA]">
            <div className="flex flex-wrap items-center gap-3">
              <span className="inline-flex items-center gap-1 font-medium text-[#141413]">
                <span className="w-2.5 h-2.5 rounded-full bg-[#F37021] inline-block" />
                <span>● Traded (TRADE)</span>
              </span>
              <span className="inline-flex items-center gap-1 font-medium text-[#57534E]">
                <span className="w-2.5 h-2.5 rounded-full border-2 border-[#141413] bg-white inline-block" />
                <span>○ Active Ask (ASK)</span>
              </span>
              {simulatedAskPrice && simulatedAskPrice > 0 ? (
                <span className="inline-flex items-center gap-1 font-mono-num text-[#141413]">
                  <span className="w-0.5 h-3 bg-[#141413] inline-block" />
                  <span>Your Ask {formatCurrency(simulatedAskPrice, currency)}</span>
                </span>
              ) : (
                <span className="text-[#8C857B]">Ask not set</span>
              )}
            </div>
            <span className="text-[#8C857B]">
              Click any dot to exclude/restore it
            </span>
          </div>

          {/* Per-Platform Rows */}
          <div className="space-y-2">
            {dotStripRows.map((row) => {
              const askPct =
                simulatedAskPrice && simulatedAskPrice > 0
                  ? priceToPct(simulatedAskPrice)
                  : null;
              const minPct =
                row.minPrice !== null ? priceToPct(row.minPrice) : null;
              const maxPct =
                row.maxPrice !== null ? priceToPct(row.maxPrice) : null;

              return (
                <div
                  key={row.platform}
                  className={`p-2.5 rounded-lg border transition-colors ${
                    row.isRecommendedNet && row.feeConfirmed
                      ? 'bg-white border-[#F37021]/60'
                      : 'bg-white border-[#E7E2DA]'
                  }`}
                  data-testid={`platform-row-${row.platform}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[11px] mb-1.5">
                    <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                      <span className="font-semibold text-[#141413] whitespace-nowrap">
                        {row.platform}
                        {row.hasSampleObservation ? ' · Sample' : ''}
                      </span>
                      <span className="text-[10px] font-mono-num text-[#8C857B] whitespace-nowrap">
                        ({row.tradedCount} Traded · {row.listedCount} Ask)
                      </span>
                      {row.isRecommendedNet && row.feeConfirmed && (
                        <span
                          className={`text-[10px] font-semibold px-1.5 py-0.5 rounded whitespace-nowrap ${confirmedRowCount >= 2 ? 'bg-[#FFF3EB] text-[#F37021] border border-[#F37021]/30' : 'bg-[#FAF8F5] text-[#57534E] border border-[#E7E2DA]'}`}
                          data-testid="best-net-star"
                          title={confirmedRowCount >= 2 ? 'Highest net at your ask among the platforms whose fee and shipping you checked' : 'Only this platform has its fee and shipping checked so far; tick another to compare'}
                        >
                          {confirmedRowCount >= 2 ? `★ Highest net among ${confirmedRowCount} checked` : 'Only platform with fees checked'}
                        </span>
                      )}
                    </div>

                    <div className="text-right font-mono-num text-[11px] shrink-0 ml-auto">
                      {row.feeConfirmed && row.conditionalNetAtAsk !== null ? (
                        <span className="font-semibold text-[#141413] whitespace-nowrap">
                          If sold: {formatCurrency(row.conditionalNetAtAsk, currency)}{' '}
                          <span className="text-[10px] text-[#8C857B] font-normal">
                            ({row.feeRatePct}% fee)
                          </span>
                        </span>
                      ) : row.feeConfirmed ? (
                        <span className="text-[10px] text-[#8C857B]">
                          Fee checked · no ask set
                        </span>
                      ) : (
                        <span
                          className="text-[10px] text-[#8C857B]"
                          data-testid="fee-unconfirmed-row"
                        >
                          Fee not confirmed (
                          {row.feeSource === 'default' ? 'default' : 'entered'}{' '}
                          {row.feeRatePct}%)
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Dot Strip Track */}
                  <div className="relative h-7 w-full bg-[#FAF8F5] rounded-md border border-[#E7E2DA] flex items-center">
                    {/* Min-to-Max Range Bar */}
                    {minPct !== null &&
                      maxPct !== null &&
                      Math.abs(maxPct - minPct) > 0.5 && (
                        <div
                          style={{
                            left: `${minPct}%`,
                            width: `${Math.max(2, maxPct - minPct)}%`,
                          }}
                          className="absolute h-2 bg-[#C5A572]/35 rounded-full"
                        />
                      )}

                    {/* Simulated Ask Price Vertical Marker */}
                    {askPct !== null && (
                      <div
                        style={{ left: `${askPct}%` }}
                        className="absolute top-0 bottom-0 w-0.5 border-l-2 border-dashed border-[#141413] -translate-x-1/2 pointer-events-none"
                      />
                    )}

                    {/* Individual Observation Dots (Clickable to exclude/include) */}
                    {row.observations.map((obs) => {
                      const leftPct = priceToPct(obs.price);
                      const isTraded = obs.kind === 'traded';
                      return (
                        <button
                          key={obs.id}
                          type="button"
                          data-testid={`comp-dot-${obs.id}`}
                          onClick={() =>
                            onToggleExcludeObs && onToggleExcludeObs(obs.id)
                          }
                          style={{ left: `${leftPct}%` }}
                          title={`${obs.platform}${obs.isSample ? ' · Sample' : ''} · ${obs.kind === 'traded' ? 'Completed Trade' : 'Active Listing'} ${formatCurrency(obs.price, currency)} (${obs.date}) — Click to ${obs.excluded ? 'restore' : 'exclude it'}`}
                          className={`absolute -translate-x-1/2 w-3.5 h-3.5 rounded-full transition-transform hover:scale-125 flex items-center justify-center ${
                            obs.excluded
                              ? 'opacity-30 bg-[#E7E2DA] border border-[#8C857B]'
                              : isTraded
                                ? 'bg-[#F37021] border-2 border-white shadow-sm'
                                : 'bg-white border-2 border-[#141413] shadow-sm'
                          }`}
                        />
                      );
                    })}
                  </div>

                  {/* Range Footer & Excluded Notice */}
                  <div className="flex items-center justify-between text-[10px] text-[#8C857B] font-mono-num mt-1">
                    <span>
                      {row.minPrice !== null && row.maxPrice !== null
                        ? row.activeCount === 1
                          ? `Single price ${formatCurrency(row.minPrice, currency)} · 1 record`
                          : `Range ${formatCurrency(row.minPrice, currency)} – ${formatCurrency(row.maxPrice, currency)} · ${row.activeCount} records`
                        : row.observations.length === 0
                          ? 'No price on record on this platform'
                          : 'All prices excluded'}
                    </span>
                    {row.observations.some((o) => o.excluded) && (
                      <span className="text-[#F37021] font-medium">
                        {row.observations.filter((o) => o.excluded).length} excluded
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        /* MODE 2: TRAJECTORY CHART, one line per platform */
        <div className="relative w-full overflow-hidden">
          <div
            className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-1 text-[10px] text-[#57534E]"
            data-testid="trajectory-legend"
          >
            {platformsInView.map((pl) => (
              <span key={pl} className="inline-flex items-center gap-1">
                <span
                  className="inline-block w-2 h-2 rounded-full"
                  style={{ background: platformColor(pl) }}
                />
                {pl}
              </span>
            ))}
            {points.length > 0 ? (
              <span className="text-[#8C857B]">
                ● trade · ○ ask · one line per platform
              </span>
            ) : (
              <span className="text-[#8C857B]">No price on record</span>
            )}
          </div>
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="w-full h-40 overflow-visible"
            role="img"
            aria-label="Recorded price trajectory chart, one line per platform"
          >
            {bandTopY !== null &&
              bandBottomY !== null &&
              Math.abs(bandBottomY - bandTopY) > 2 && (
                <rect
                  x={padX}
                  y={Math.min(bandTopY, bandBottomY)}
                  width={width - padX * 2}
                  height={Math.max(4, Math.abs(bandBottomY - bandTopY))}
                  fill="#C5A572"
                  fillOpacity="0.11"
                  rx="3"
                />
              )}

            {[0.2, 0.5, 0.8].map((ratio, i) => (
              <line
                key={i}
                x1={padX}
                x2={width - padX}
                y1={padY + ratio * (height - padY * 2)}
                y2={padY + ratio * (height - padY * 2)}
                stroke="#E7E2DA"
                strokeDasharray="2 3"
                strokeWidth="1"
              />
            ))}

            {purchaseY !== null && (
              <g>
                <line
                  x1={padX}
                  x2={width - padX}
                  y1={purchaseY}
                  y2={purchaseY}
                  stroke="#C5A572"
                  strokeDasharray="4 4"
                  strokeWidth="1"
                />
                <text
                  x={width - padX}
                  y={Math.max(12, purchaseY - 5)}
                  textAnchor="end"
                  className="fill-[#8C857B] text-[9px] font-mono-num"
                >
                  Purchase price {formatCurrency(purchasePrice!, currency)}
                </text>
              </g>
            )}

            {/* One line per platform; records from different platforms are never joined. */}
            {platformLines.map((line) => (
              <polyline
                key={line.platform}
                data-testid={`trajectory-line-${line.platform}`}
                fill="none"
                stroke={platformColor(line.platform)}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                points={line.polyline}
              />
            ))}

            {askY !== null && simulatedAskPrice && (
              <g>
                <line
                  x1={padX}
                  x2={width - padX}
                  y1={askY}
                  y2={askY}
                  stroke="#141413"
                  strokeDasharray="3 3"
                  strokeWidth="1.5"
                />
                <rect
                  x={padX + 4}
                  y={Math.max(4, Math.min(height - 34, askY - 9))}
                  width={126}
                  height={16}
                  rx={4}
                  fill="#141413"
                />
                <text
                  x={padX + 10}
                  y={Math.max(15, Math.min(height - 23, askY + 2))}
                  className="fill-white text-[9px] font-mono-num font-semibold"
                >
                  Ask {formatCurrency(simulatedAskPrice, currency)}
                </text>
              </g>
            )}

            {points.map((pt, i) => {
              const isLast = i === points.length - 1;
              const color = platformColor(pt.obs.platform);
              return (
                <g key={pt.obs.id}>
                  {isLast && (
                    <circle
                      cx={pt.x}
                      cy={pt.y}
                      r="9"
                      fill={color}
                      fillOpacity="0.18"
                    />
                  )}
                  {/* Trade = filled dot, ask = hollow dot */}
                  <circle
                    cx={pt.x}
                    cy={pt.y}
                    r={isLast ? 4.5 : 3}
                    fill={pt.obs.kind === 'traded' ? color : '#FFFFFF'}
                    stroke={color}
                    strokeWidth="2"
                  />
                  <title>{`${pt.obs.date} · ${pt.obs.platform} · ${pt.obs.kind === 'traded' ? 'trade' : 'ask'} ${formatCurrency(pt.obs.price, currency)}${pt.obs.isSample ? ' · Sample' : ''}`}</title>
                  {labelled.has(i) && (
                    <text
                      x={pt.x}
                      y={height - 6}
                      textAnchor={
                        i === 0
                          ? 'start'
                          : i === points.length - 1
                            ? 'end'
                            : 'middle'
                      }
                      className="fill-[#8C857B] text-[10px] font-mono-num"
                    >
                      {pt.obs.date.slice(5)} · {pt.obs.platform}
                      {pt.obs.isSample ? ' · Sample' : ''}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      )}

      {/* Minimalist footer provenance */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 text-[11px] text-[#8C857B] pt-2 border-t border-[#E7E2DA]">
        <span>
          {tradedBandMin !== null && tradedBandMax !== null
            ? `Trade range: ${formatCurrency(tradedBandMin, currency)} – ${formatCurrency(tradedBandMax, currency)}${
                tradedCount !== null ? ` · ${plural(tradedCount, 'trade')}` : ''
              }`
            : first
              ? `First price on record ${first.date} (${formatCurrency(first.price, currency)})${
                  first.isSample ? ' · Sample' : ''
                }`
              : 'No price on record'}
        </span>
        <span>No cross-platform averaging or FX mixing</span>
      </div>
    </div>
  );
};
