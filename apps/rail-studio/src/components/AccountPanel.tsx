import React, { useEffect, useRef, useState } from 'react';
import { X, UserRound, LogOut, RefreshCw } from 'lucide-react';
import type { AccountState, AccountWardrobeController } from '../utils/accountWardrobe';

type Props = {
  isOpen: boolean; onClose: () => void; state: AccountState;
  controller: AccountWardrobeController; persistenceNotice: string;
};
export function AccountPanel({ isOpen, onClose, state, controller, persistenceNotice }: Props) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [handle, setHandle] = useState('');
  const [password, setPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isOpen) { setPassword(''); setFormError(null); return; }
    const previous = document.activeElement as HTMLElement | null;
    const first = panel.current?.querySelector<HTMLElement>('input, button');
    first?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key !== 'Tab') return;
      const nodes = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? []);
      const firstNode = nodes[0], lastNode = nodes[nodes.length - 1];
      if (!firstNode) return;
      if (event.shiftKey && (document.activeElement === firstNode || !panel.current?.contains(document.activeElement))) { event.preventDefault(); lastNode.focus(); }
      else if (!event.shiftKey && document.activeElement === lastNode) { event.preventDefault(); firstNode.focus(); }
    };
    panel.current?.addEventListener('keydown', trap);
    const element = panel.current;
    return () => { element?.removeEventListener('keydown', trap); previous?.focus(); };
  }, [isOpen, onClose]);
  if (!isOpen) return null;
  const act = async (operation: () => Promise<void> | void) => {
    setFormError(null);
    try { await operation(); }
    catch (error) { setFormError(error instanceof Error ? error.message : 'Please try again.'); }
  };
  const button = 'min-h-11 rounded-lg border border-[#E7E2DA] px-3 py-2 text-sm font-medium disabled:opacity-50';
  return <div className="fixed inset-0 z-[90] bg-black/25 flex items-center justify-center p-4" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={panel} role="dialog" aria-modal="true" aria-labelledby="account-title" className="w-full max-w-md max-h-[90dvh] overflow-y-auto rounded-2xl border border-[#E7E2DA] bg-white p-5 shadow-xl">
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 id="account-title" className="text-lg font-semibold inline-flex items-center gap-2"><UserRound size={19} />{state.account ? 'Your account' : 'Save your own wardrobe'}</h2>
        <button type="button" onClick={onClose} aria-label="Close account panel" className="min-h-11 min-w-11 flex items-center justify-center rounded-lg hover:bg-stone-100"><X size={20} /></button>
      </div>
      {state.account ? <div className="space-y-4">
        <div className="rounded-xl bg-[#F7F5F1] p-4">
          <p className="text-sm text-[#57534E]">Signed in as</p><p className="font-semibold break-all">{state.account.handle}</p>
          <p role="status" className="text-sm mt-2 text-[#57534E]">{persistenceNotice}</p>
        </div>
        <p className="text-sm text-[#57534E]">Your own photos, prices and decisions are saved to this server. The sample closet stays separate.</p>
        {state.status === 'error' && <button type="button" className={button} onClick={() => void act(() => controller.retry())} disabled={state.busy}><RefreshCw className="inline mr-2" size={15} />Retry save</button>}
        {state.status === 'conflict' && <div className="rounded-lg border border-orange-200 bg-orange-50 p-3 text-sm">
          <p>Another tab saved a newer version. Your changes have not replaced it.</p>
          <button type="button" className={`${button} mt-2 bg-white`} disabled={state.busy} onClick={() => {
            if (window.confirm('Load the saved wardrobe and discard the unsaved changes in this tab?')) void act(() => controller.reload());
          }}>Load saved wardrobe</button>
        </div>}
        {!state.sampleView && state.localCount > 0 && <div className="rounded-lg border border-[#E7E2DA] p-3">
          <p className="text-sm mb-2">This browser has {state.localCount} personal piece{state.localCount === 1 ? '' : 's'}. Nothing is imported automatically.</p>
          <button type="button" className={button} disabled={state.busy || state.status === 'loading'} onClick={() => controller.importLocal()}>Bring my local pieces</button>
        </div>}
        <div className="flex flex-wrap gap-2">
          <button type="button" className={button} disabled={state.busy || state.status === 'loading'} onClick={() => void act(() => controller.toggleSample())}>{state.sampleView ? 'Back to my wardrobe' : 'Explore sample closet'}</button>
          <button type="button" className={button} disabled={state.busy || state.status === 'loading'} onClick={() => void act(async () => { await controller.logout(); setPassword(''); })}><LogOut className="inline mr-2" size={15} />Sign out</button>
        </div>
      </div> : <>
        <p className="text-sm text-[#57534E] mb-4">Explore freely. Sign in when you want your own pieces and decisions saved across visits.</p>
        <div className="flex rounded-lg bg-[#F7F5F1] p-1 mb-4">
          {(['login', 'register'] as const).map(value => <button key={value} type="button" disabled={state.busy} aria-pressed={mode === value} onClick={() => { setMode(value); setFormError(null); }} className={`min-h-11 flex-1 rounded-md text-sm ${mode === value ? 'bg-white shadow-sm font-semibold' : 'text-[#57534E]'}`}>{value === 'login' ? 'Sign in' : 'Create account'}</button>)}
        </div>
        <form onSubmit={event => { event.preventDefault(); void act(async () => { await controller.authenticate(mode, handle, password); setPassword(''); }); }} className="space-y-3">
          <label className="block text-sm font-medium" htmlFor="closer-handle">Username<input id="closer-handle" name="username" value={handle} onChange={event => setHandle(event.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} minLength={2} maxLength={64} required disabled={state.busy} className="mt-1 block w-full min-h-11 rounded-lg border border-[#D7D1C8] px-3 font-normal" /></label>
          <label className="block text-sm font-medium" htmlFor="closer-password">Password<input id="closer-password" name="password" type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} minLength={mode === 'register' ? 8 : 1} maxLength={128} required disabled={state.busy} className="mt-1 block w-full min-h-11 rounded-lg border border-[#D7D1C8] px-3 font-normal" /></label>
          {mode === 'register' && <p className="text-xs text-[#57534E]">Use at least 8 characters. Sample pieces are never added to your account.</p>}
          <button type="submit" disabled={state.busy} className="w-full min-h-11 rounded-lg bg-[#141413] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{state.busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
        </form>
      </>}
      {(formError || state.error) && <p role="alert" className="mt-4 rounded-lg bg-orange-50 p-3 text-sm text-[#9A3412] break-words">{formError || state.error}</p>}
    </div>
  </div>;
}
