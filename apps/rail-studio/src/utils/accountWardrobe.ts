import type { GarmentPiece } from '../types/closet';

export type Account = { handle: string; workspaceId: string };
export type SaveStatus = 'local' | 'loading' | 'saving' | 'saved' | 'error' | 'conflict';
export type AccountState = {
  account: Account | null; pieces: GarmentPiece[]; revision: number; ledgerRevision: number;
  ledgerStatus: 'verified' | 'partial' | null; ledgerWarnings: string[];
  status: SaveStatus; error: string | null; busy: boolean; sampleView: boolean;
  epoch: number; localCount: number;
};
export type Request = (url: string, init?: RequestInit) => Promise<Response>;
const DEMO_IDS = new Set(['piece-j1', 'piece-j2', 'piece-t1', 'piece-j3', 'piece-t2', 'piece-b1', 'piece-j4', 'piece-k1', 'piece-t3', 'piece-s1']);
export const LOCAL_KEY = 'closer.scannedPieces.v1';

/** Built-in display fixtures must never become personal records, even when their old flag is false. */
export function isPersonalPiece(piece: GarmentPiece): boolean {
  return Boolean(piece && !DEMO_IDS.has(piece.id) &&
    /^(scan-|piece-custom-)/.test(piece.id) && piece.isSample === false && piece.scanMode !== 'fake' &&
    Array.isArray(piece.observations) && !piece.observations.some(row => row.isSample));
}
export function localPieces(pieces: GarmentPiece[]): GarmentPiece[] {
  return pieces.filter(piece => piece && /^(scan-|piece-custom-)/.test(piece.id));
}
export function loadLocalPieces(storage?: Pick<Storage, 'getItem'>): GarmentPiece[] {
  try {
    const value: unknown = JSON.parse(storage?.getItem(LOCAL_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((p): p is GarmentPiece =>
      p && typeof p.id === 'string' && /^(scan-|piece-custom-)/.test(p.id) &&
      typeof p.code === 'string' && typeof p.name === 'string' && Array.isArray(p.observations) &&
      p.feeConfig && typeof p.colorHex === 'string') : [];
  } catch { return []; }
}

class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
type SavedDocument = { workspaceId: string; revision: number; ledgerRevision: number;
  ledgerStatus: 'verified' | 'partial'; ledgerWarnings?: string[]; pieces: GarmentPiece[] };
type PendingSave = { requestId: string; workspaceId: string; expectedRevision: number; expectedLedgerRevision: number; pieces: GarmentPiece[]; version: number };

/** One queue per signed-in identity; private records never pass through the local storage callback. */
export class AccountWardrobeController {
  private state: AccountState;
  private listeners = new Set<() => void>();
  private guest: GarmentPiece[];
  private privatePieces: GarmentPiece[] = [];
  private editVersion = 0;
  private savedVersion = 0;
  private running: Promise<void> | null = null;
  private disposed = false;
  private checking = false;
  private initialized = false;
  private sessionOperation = 0;
  private pendingSave: PendingSave | null = null;

  constructor(private request: Request, private seed: GarmentPiece[], guestPieces: GarmentPiece[],
    private saveLocal: (pieces: GarmentPiece[]) => void = () => {}) {
    this.guest = [...seed, ...guestPieces];
    this.state = { account: null, pieces: this.guest, revision: 0, ledgerRevision: 0, ledgerStatus: null, ledgerWarnings: [], status: 'local', error: null,
      busy: false, sampleView: false, epoch: 0, localCount: guestPieces.filter(isPersonalPiece).length };
  }
  getSnapshot = (): AccountState => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit(patch: Partial<AccountState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private async api(path: string, method = 'GET', body?: unknown): Promise<any> {
    const response = await this.request(`/api/account${path}`, {
      method, credentials: 'same-origin', cache: 'no-store',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    let data: any;
    try { data = await response.json(); } catch { throw new ApiError('The server did not return a readable response. Try again.', response.status); }
    if (!response.ok || data?.ok !== true) throw new ApiError(data?.detail || data?.error || 'The request could not be completed.', response.status);
    return data;
  }
  private document(data: any, workspaceId: string): SavedDocument {
    if (data?.workspaceId !== workspaceId || !Number.isInteger(data?.revision) || data.revision < 0 ||
      !Number.isSafeInteger(data?.ledgerRevision) || data.ledgerRevision < 0 ||
      !['verified', 'partial'].includes(data?.ledgerStatus) ||
      !Array.isArray(data?.pieces) || !data.pieces.every(isPersonalPiece)) {
      throw new ApiError('The saved wardrobe could not be verified. Please reload it.', 502);
    }
    return data;
  }
  private becomeGuest(message: string | null = null) {
    this.privatePieces = []; this.editVersion = 0; this.savedVersion = 0; this.pendingSave = null;
    this.emit({ account: null, pieces: this.guest, revision: 0, ledgerRevision: 0, ledgerStatus: null, ledgerWarnings: [], sampleView: false,
      status: 'local', busy: false, error: message, epoch: this.state.epoch + 1 });
  }
  private async hydrate(account: Account, operation: number) {
    if (operation !== this.sessionOperation) return;
    const epoch = this.state.epoch + 1;
    this.privatePieces = []; this.editVersion = 0; this.savedVersion = 0; this.pendingSave = null;
    this.emit({ account, pieces: [], revision: 0, ledgerRevision: 0, ledgerStatus: null, ledgerWarnings: [], sampleView: false, status: 'loading', error: null, epoch });
    try {
      const data = this.document(await this.api('/wardrobe'), account.workspaceId);
      if (this.disposed || this.state.epoch !== epoch || operation !== this.sessionOperation) return;
      this.privatePieces = data.pieces;
      this.emit({ pieces: data.pieces, revision: data.revision, ledgerRevision: data.ledgerRevision,
        ledgerStatus: data.ledgerStatus, ledgerWarnings: data.ledgerWarnings ?? [], status: 'saved' });
    } catch (error) {
      // Failed requests need the same ownership check as successful responses.
      if (!this.disposed && this.state.epoch === epoch && operation === this.sessionOperation) this.fail(error);
    }
  }
  async checkSession() {
    if (this.state.busy || this.disposed || this.checking) return;
    this.checking = true;
    const firstCheck = !this.initialized;
    const epoch = this.state.epoch;
    const operation = ++this.sessionOperation;
    if (firstCheck) this.emit({ busy: true });
    try {
      const data = await this.api('');
      if (this.state.epoch !== epoch || operation !== this.sessionOperation) return;
      if (!data.signedIn) {
        if (this.state.account) this.becomeGuest('Your session ended. Sign in to open your saved wardrobe.');
      } else if (data.workspaceId !== this.state.account?.workspaceId) {
        await this.hydrate({ handle: data.handle, workspaceId: data.workspaceId }, operation);
      }
    } catch (error) {
      if (this.state.epoch === epoch && operation === this.sessionOperation) this.fail(error);
    } finally {
      this.checking = false; this.initialized = true;
      if (firstCheck && operation === this.sessionOperation) this.emit({ busy: false });
    }
  }
  async authenticate(action: 'register' | 'login', handle: string, password: string) {
    if (this.state.busy) return;
    const operation = ++this.sessionOperation;
    const epoch = this.state.epoch;
    if (this.state.account) await this.flush();
    if (this.state.epoch !== epoch || operation !== this.sessionOperation) throw new Error('Your account changed. Please try again.');
    this.emit({ busy: true, error: null });
    try {
      const data = await this.api(`/${action}`, 'POST', { handle, password });
      if (operation !== this.sessionOperation) return;
      await this.hydrate({ handle: data.handle, workspaceId: data.workspaceId }, operation);
    } catch (error) {
      if (operation === this.sessionOperation) { this.fail(error); throw error; }
    } finally {
      if (operation === this.sessionOperation) { this.initialized = true; this.emit({ busy: false }); }
    }
  }
  update(updater: GarmentPiece[] | ((pieces: GarmentPiece[]) => GarmentPiece[])) {
    if (this.state.status === 'loading' || this.state.busy) return;
    const pieces = typeof updater === 'function' ? updater(this.state.pieces) : updater;
    if (pieces === this.state.pieces) return;
    if (this.state.sampleView) { this.emit({ pieces }); return; }
    if (!this.state.account) {
      this.guest = pieces;
      try { this.saveLocal(localPieces(pieces)); }
      catch { this.emit({ error: 'Browser storage is full or unavailable. These changes are only kept for this visit.' }); }
      this.emit({ pieces, localCount: pieces.filter(isPersonalPiece).length });
      return;
    }
    if (!pieces.every(isPersonalPiece)) {
      this.emit({ error: 'Sample pieces stay in the sample closet. Add your own photo to save a personal piece.' }); return;
    }
    this.privatePieces = pieces; this.editVersion++;
    const blocked = this.state.status === 'conflict' || this.state.status === 'error';
    this.emit({ pieces, ...(blocked ? {} : { status: 'saving', error: null }) });
    if (!blocked) void this.drain();
  }
  private fail(error: unknown) {
    const message = error instanceof Error ? error.message : 'Could not save. Please try again.';
    if (error instanceof ApiError && (error.status === 401 || error.status === 403) && this.state.account) {
      this.becomeGuest('Your session changed. Sign in again to open the correct wardrobe.'); return;
    }
    this.emit({ error: message, status: this.state.account ? error instanceof ApiError && error.status === 409 ? 'conflict' : 'error' : 'local' });
  }
  private drain(): Promise<void> {
    if (this.running) return this.running;
    const epoch = this.state.epoch;
    const workspaceId = this.state.account?.workspaceId;
    if (!workspaceId || this.state.sampleView) return Promise.resolve();
    this.running = (async () => {
      while (!this.disposed && this.state.epoch === epoch && this.savedVersion < this.editVersion) {
        // Keep the exact request across an uncertain network result. A later local edit
        // waits behind this request, so retry cannot create a duplicate ledger event.
        const pending = this.pendingSave ??= {
          requestId: crypto.randomUUID(), workspaceId, expectedRevision: this.state.revision,
          expectedLedgerRevision: this.state.ledgerRevision,
          pieces: structuredClone(this.privatePieces), version: this.editVersion,
        };
        const { version, expectedRevision: revision, ...body } = pending;
        this.emit({ status: 'saving', error: null });
        try {
          const data = this.document(await this.api('/wardrobe', 'PUT', { ...body, expectedRevision: revision }), workspaceId);
          if (this.state.epoch !== epoch || this.disposed) return;
          if (data.revision !== revision + 1 || data.ledgerRevision <= pending.expectedLedgerRevision) throw new ApiError('The save revision could not be verified.', 502);
          this.pendingSave = null;
          this.savedVersion = version;
          if (this.editVersion === version) this.privatePieces = data.pieces;
          this.emit({ revision: data.revision, ledgerRevision: data.ledgerRevision, ledgerStatus: data.ledgerStatus,
            ledgerWarnings: data.ledgerWarnings ?? [], pieces: this.privatePieces });
        } catch (error) {
          if (this.state.epoch === epoch) {
            // The server rejected this body before committing it. A corrected edit
            // needs a new request; only uncertain results retain the exact retry.
            if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 409) this.pendingSave = null;
            this.fail(error);
          }
          return;
        }
      }
      if (this.state.epoch === epoch && !this.disposed) this.emit({ status: 'saved', error: null });
    })().finally(() => {
      this.running = null;
      // A prior identity's request may finish after a new wardrobe was opened.
      if (!this.disposed && this.state.account && !this.state.sampleView && this.savedVersion < this.editVersion &&
        this.state.status === 'saving') void this.drain();
    });
    return this.running;
  }
  async flush() {
    do {
      if (this.state.status === 'error' || this.state.status === 'conflict') {
        throw new Error(this.state.error || 'Resolve the save problem before leaving this wardrobe.');
      }
      await this.drain();
      if (!this.state.account) return;
    } while (this.running || this.savedVersion < this.editVersion && this.state.status === 'saving');
    const current = this.getSnapshot();
    if (current.account && (current.status === 'error' || current.status === 'conflict' || this.savedVersion < this.editVersion)) {
      throw new Error(current.error || 'Save your changes before leaving this wardrobe.');
    }
  }
  async retry() {
    if (this.state.status === 'conflict') return;
    if (this.state.account && this.state.revision === 0 && this.editVersion === 0 && this.state.status === 'error') return this.reload();
    await this.drain();
  }
  async reload() {
    if (!this.state.account || this.state.busy) return;
    const operation = ++this.sessionOperation;
    this.emit({ busy: true });
    try { await this.hydrate(this.state.account, operation); }
    finally { if (operation === this.sessionOperation) this.emit({ busy: false }); }
  }
  async logout() {
    if (this.state.busy) return;
    const operation = ++this.sessionOperation;
    const epoch = this.state.epoch;
    await this.flush();
    if (this.state.epoch !== epoch || operation !== this.sessionOperation) throw new Error('Your account changed. Please review it before signing out.');
    this.emit({ busy: true, error: null });
    try {
      await this.api('/logout', 'POST', {});
      if (operation === this.sessionOperation && this.state.epoch === epoch) this.becomeGuest();
    } catch (error) {
      if (operation === this.sessionOperation && this.state.epoch === epoch) { this.fail(error); throw error; }
    } finally { if (operation === this.sessionOperation) this.emit({ busy: false }); }
  }
  async toggleSample() {
    if (!this.state.account || this.state.busy || this.state.status === 'loading') return;
    if (!this.state.sampleView) await this.flush();
    this.emit({ sampleView: !this.state.sampleView, pieces: this.state.sampleView ? this.privatePieces : [...this.seed], epoch: this.state.epoch + 1 });
  }
  importLocal() {
    if (!this.state.account || this.state.sampleView) return;
    const existing = new Set(this.privatePieces.map(p => p.id));
    this.update([...this.privatePieces, ...this.guest.filter(p => isPersonalPiece(p) && !existing.has(p.id))]);
  }
  reportError(message: string) { this.emit({ error: message }); }
  dispose() { this.disposed = true; this.listeners.clear(); }
}
