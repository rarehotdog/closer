import React, { useEffect, useState } from 'react';
import { RefreshCw, BookOpenCheck } from 'lucide-react';
import type { ClosetLedger } from '../../../../engine/ledger';
import type { AccountState } from '../utils/accountWardrobe';

type Report = {
  ok: boolean; workspaceId: string; revision: number; ledgerRevision: number;
  ledgerStatus: 'verified' | 'partial'; ledgerWarnings: string[];
  summary: ClosetLedger;
  state: { events: { eventId: string; kind: string; recordedAt: string; ledgerRevision: number }[] };
  decisions: unknown[];
  calls: { callId: string; model: string; http: number; source: string; createdAt: string }[];
};
const money = (value: number, currency: string) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency, maximumFractionDigits: currency === 'KRW' ? 0 : 2,
}).format(value);
const activity = (kind: string) => ({
  REGISTRATION_CONFIRMED: 'Piece added', WARDROBE_UPDATED: 'Wardrobe details saved',
  ITEM_UPDATED: 'Piece details saved', ITEM_REMOVED: 'Piece removed',
  WARDROBE_IMPORTED: 'Saved wardrobe imported', WEAR_CONFIRMED: 'Wear confirmed',
  WEAR_UNDONE: 'Wear corrected', AVAILABILITY_CHANGED: 'Availability changed',
}[kind] ?? kind.toLowerCase().replaceAll('_', ' '));

/** Fetch the canonical report for the visible identity; never reuse another account's report. */
export function CanonicalLedgerPanel({ state }: { state: AccountState }) {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const workspaceId = state.account?.workspaceId;
  const settled = state.status === 'saved';
  useEffect(() => {
    const abort = new AbortController();
    setReport(null); setError(null);
    if (!workspaceId || !settled) return () => abort.abort();
    void (async () => {
      try {
        const response = await fetch('/api/account/ledger', { credentials: 'same-origin', cache: 'no-store', signal: abort.signal });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.detail || 'Could not read your saved ledger.');
        if (data.workspaceId !== workspaceId || !data.summary || !Array.isArray(data.state?.events) ||
          !Array.isArray(data.calls) || !Array.isArray(data.decisions) || !Number.isSafeInteger(data.ledgerRevision)) {
          throw new Error('The saved ledger could not be verified. Please reload your wardrobe.');
        }
        if (!abort.signal.aborted) setReport(data);
      } catch (problem) {
        if (!abort.signal.aborted) setError(problem instanceof Error ? problem.message : 'Could not read your saved ledger.');
      }
    })();
    return () => abort.abort();
  }, [workspaceId, state.revision, state.ledgerRevision, settled, attempt]);
  if (!workspaceId) return null;
  const visible = report?.workspaceId === workspaceId ? report : null;
  const inSync = visible && visible.revision === state.revision && visible.ledgerRevision === state.ledgerRevision;
  return <section aria-label="Saved ledger" className="rounded-xl border border-[#E7E2DA] bg-white p-4 space-y-3">
    <div className="flex items-center justify-between gap-3">
      <h3 className="text-sm font-semibold inline-flex items-center gap-2"><BookOpenCheck size={17} />Saved ledger</h3>
      <button type="button" aria-label="Refresh saved ledger" disabled={!settled} onClick={() => setAttempt(n => n + 1)} className="min-h-11 min-w-11 rounded-lg flex items-center justify-center hover:bg-stone-100 disabled:opacity-40"><RefreshCw size={15} /></button>
    </div>
    {!settled ? <p role="status" className="text-sm text-stone-600">Save your latest changes to verify them here.</p> : error ? <p role="alert" className="text-sm text-amber-800">{error}</p> : !visible ? <p role="status" className="text-sm text-stone-600">Reading your saved records…</p> : <>
      <p role="status" className="text-sm text-stone-600">{inSync ? 'Matches your saved wardrobe.' : 'The ledger has newer changes. Reload your saved wardrobe before editing.'}</p>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div><span className="text-xl font-semibold block">{visible.summary.pieces}</span>personal pieces</div>
        <div><span className="text-xl font-semibold block">{visible.summary.withOwnerEvidence}</span>with entered prices</div>
      </div>
      {visible.summary.byCurrency.filter(row => row.owner.pieces > 0).map(row => <div key={row.currency} className="flex justify-between gap-3 border-t border-stone-100 pt-2 text-sm">
        <span>{row.currency} · {row.owner.pieces} priced</span><strong>{money(row.owner.total, row.currency)}</strong>
      </div>)}
      <p className="text-xs leading-relaxed text-stone-500">Latest entered price per piece, separately by currency. Asking prices are not sales. Pieces without a price are not counted as zero.</p>
      {visible.summary.net.byCurrency.map(row => <p key={row.currency} className="text-sm"><strong>{money(row.total, row.currency)}</strong> net in {row.pieces} saved cost snapshot{row.pieces === 1 ? '' : 's'}.</p>)}
      {visible.ledgerWarnings?.length > 0 && <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900 space-y-1">{visible.ledgerWarnings.map((warning, i) => <p key={i}>{warning}</p>)}</div>}
      <details className="border-t border-stone-100 pt-3">
        <summary className="cursor-pointer text-sm font-medium min-h-8">Saved activity · {visible.state.events.length} records</summary>
        <ol className="space-y-2 mt-2 text-xs text-stone-600">{visible.state.events.slice(-8).reverse().map(event => <li key={event.eventId} className="flex justify-between gap-2"><span>{activity(event.kind)}</span><time dateTime={event.recordedAt}>{new Date(event.recordedAt).toLocaleString('en-GB', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</time></li>)}</ol>
        <p className="mt-2 text-xs text-stone-500">{visible.decisions.length} saved decision{visible.decisions.length === 1 ? '' : 's'}. Reported wear counts do not create confirmed wear events.</p>
      </details>
      <details className="border-t border-stone-100 pt-3">
        <summary className="cursor-pointer text-sm font-medium min-h-8">Recent photo analysis requests · {visible.calls.length}</summary>
        {visible.calls.length === 0 ? <p className="text-xs text-stone-500 mt-2">No model response recorded for this account yet.</p> : <ul className="space-y-2 mt-2 text-xs text-stone-600">{visible.calls.slice(0, 8).map(call => <li key={call.callId}><span className="font-medium">{call.model}</span> · {call.source === 'live' ? 'Meta' : 'Test only'} · {call.http >= 200 && call.http < 300 ? `HTTP ${call.http}` : `Request failed (${call.http || 'network'})`}</li>)}</ul>}
        <p className="text-xs text-stone-500 mt-2">A successful request is separate from a usable garment mask. The photo preview identifies masks and box crops.</p>
      </details>
    </>}
  </section>;
}
