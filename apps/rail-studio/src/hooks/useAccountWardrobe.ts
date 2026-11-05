import { useEffect, useState, useSyncExternalStore } from 'react';
import { INITIAL_GARMENTS } from '../data/seedCloset';
import { AccountWardrobeController, loadLocalPieces, LOCAL_KEY } from '../utils/accountWardrobe';

function readGuest() {
  try { return typeof window === 'undefined' ? [] : loadLocalPieces(window.localStorage); }
  catch { return []; }
}

export function useAccountWardrobe() {
  const [controller] = useState(() => new AccountWardrobeController(
    (url, options) => fetch(url, options), INITIAL_GARMENTS,
    readGuest(),
    pieces => window.localStorage.setItem(LOCAL_KEY, JSON.stringify(pieces)),
  ));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    void controller.checkSession();
    const onFocus = () => { void controller.checkSession(); };
    window.addEventListener('focus', onFocus);
    const onLeave = (event: BeforeUnloadEvent) => {
      const s = controller.getSnapshot();
      if (s.account && ['saving', 'error', 'conflict'].includes(s.status)) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', onLeave);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('beforeunload', onLeave);
    };
  }, [controller]);
  const persistenceNotice = state.sampleView ? 'Sample closet · changes reset when you leave this view' : state.account
    ? ({ local: 'Local only', loading: 'Loading your wardrobe…', saving: 'Saving to account…', saved: 'Saved to account · verified after save', error: 'Could not save · retry from Account', conflict: 'Another tab saved changes · review from Account' })[state.status]
    : 'This browser only · sign in to save your own pieces across visits';
  return { ...state, controller, persistenceNotice };
}
