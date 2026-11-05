import express, { type Request, type Response } from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ExtrasStore, type AccountSummary } from '../../../store/extras.ts';
import { formatAccountCookie, hashPassword, hashSessionToken, normalizeHandle, readCookie, SESSION_TTL_MS, validPassword, verifyPassword, RateLimiter } from '../../../web/guard.ts';
import { AccountWardrobeStore } from './accountStore.ts';
import { InvalidWardrobe, MAX_WARDROBE_BYTES, validateWardrobe } from './wardrobeSchema.ts';

export interface AccountRouterOptions {
  dbPath: string;
  allowedOrigins?: string[];
  secureCookies?: boolean;
  cookieName?: string;
}
/** Mount at /api/account. The caller owns close(), including test teardown. */
export function createAccountRouter(options: AccountRouterOptions) {
  if (options.dbPath !== ':memory:') mkdirSync(dirname(options.dbPath), { recursive: true, mode: 0o700 });
  const accounts = new ExtrasStore(options.dbPath);
  const wardrobe = new AccountWardrobeStore(options.dbPath);
  const cookieName = options.cookieName ?? 'closer_rail_acct';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(cookieName)) throw new Error('Invalid account cookie name');
  const router = express.Router();
  const authLimit = new RateLimiter(30, 10 * 60_000);
  const writeLimit = new RateLimiter(240, 60_000);
  const token = (req: Request): string | null => {
    const value = readCookie(req.headers.cookie, cookieName);
    return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
  };
  const session = (req: Request) => { const value = token(req); return value ? accounts.sessionAccount(hashSessionToken(value)) : null; };
  const cookie = (req: Request, res: Response, value: string | null) => res.setHeader('Set-Cookie',
    formatAccountCookie(value, options.secureCookies === true || req.secure).replace(/^[^=]+=/, `${cookieName}=`));
  const state = (a: AccountSummary | null) => ({ok:true, signedIn:!!a, handle:a?.handle ?? null, workspaceId:a?.workspaceId ?? null});
  const problem = (res: Response, status: number, code: string, detail: string) => res.status(status).json({ok:false,code,detail});
  const limited = (req: Request, res: Response, bucket: RateLimiter) => {
    const wait = bucket.take(req.socket.remoteAddress ?? 'local');
    if (wait === null) return false;
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(wait / 1000))));
    problem(res,429,'RATE_LIMITED','Too many requests. Please try again shortly.'); return true;
  };
  router.use((req,res,next) => {
    res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff');
    const origin = req.headers.origin;
    const allowed = options.allowedOrigins ?? [`${req.protocol}://${req.get('host')}`];
    const mutation = !['GET','HEAD','OPTIONS'].includes(req.method);
    if ((mutation && !origin) || (origin && !allowed.includes(origin)) || req.headers['sec-fetch-site'] === 'cross-site') {
      problem(res,403,'ORIGIN_DENIED','Use this app to access your account.'); return;
    }
    if (mutation && req.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      problem(res,415,'BAD_INPUT','Send a JSON request.'); return;
    }
    next();
  });
  router.use(express.json({limit:MAX_WARDROBE_BYTES, strict:true}));
  router.use((req,res,next) => {
    if (!['GET','HEAD','OPTIONS'].includes(req.method) && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) {
      problem(res,400,'BAD_INPUT','Send a JSON object.'); return;
    }
    next();
  });
  router.get('/',(req,res) => { res.json(state(session(req))); });
  router.post('/register', async (req,res,next) => {
    try {
      if (limited(req,res,authLimit)) return;
      if ('claimWorkspaceId' in req.body) { problem(res,400,'CLAIM_NOT_ALLOWED','Add your own pieces after creating an account.'); return; }
      const handle = normalizeHandle(req.body.handle), password = validPassword(req.body.password);
      if (!handle || !password) { problem(res,400,'BAD_INPUT','Use a handle of 2–64 letters or digits and a password of 8–128 bytes.'); return; }
      if (accounts.accountByHandle(handle)) { problem(res,409,'HANDLE_TAKEN','That handle is already registered.'); return; }
      const {salt,hash} = await hashPassword(password);
      // Hashing yields; check again before the atomic insert to handle simultaneous sign-ups.
      if (accounts.accountByHandle(handle)) { problem(res,409,'HANDLE_TAKEN','That handle is already registered.'); return; }
      const now = Date.now(), value = randomBytes(32).toString('hex');
      const a = accounts.createAccountWithSession({accountId:`acc-${randomUUID()}`,handle,salt,passwordHash:hash,workspaceId:`acct-${randomUUID()}`,createdAt:new Date(now).toISOString()}, hashSessionToken(value), now+SESSION_TTL_MS,now);
      const previous = token(req); if (previous) accounts.deleteAccountSession(hashSessionToken(previous));
      cookie(req,res,value); res.json(state(a));
    } catch (error) { next(error); }
  });
  router.post('/login',async(req,res,next) => {
    try {
      if (limited(req,res,authLimit)) return;
      const handle = normalizeHandle(req.body.handle), password = validPassword(req.body.password);
      if (!handle || !password) { problem(res,401,'INVALID_CREDENTIALS','Handle or password did not match.'); return; }
      const a = accounts.accountByHandle(handle);
      if (!(await verifyPassword(password,a?.salt??null,a?.passwordHash??null)) || !a) {
        problem(res,401,'INVALID_CREDENTIALS','Handle or password did not match.'); return;
      }
      const now = Date.now(), value = randomBytes(32).toString('hex');
      accounts.createAccountSession(hashSessionToken(value),a.accountId,now+SESSION_TTL_MS,now);
      const previous = token(req); if (previous) accounts.deleteAccountSession(hashSessionToken(previous));
      cookie(req,res,value); res.json(state(a));
    } catch(error) { next(error); }
  });
  router.post('/logout',(req,res) => {
    const value = token(req); if (value) accounts.deleteAccountSession(hashSessionToken(value));
    cookie(req,res,null); res.json(state(null));
  });
  router.get('/wardrobe',(req,res) => {
    const a = session(req); if (!a) { problem(res,401,'SESSION_REQUIRED','Sign in to open your saved wardrobe.'); return; }
    res.json({ok:true,...wardrobe.read(a.workspaceId)});
  });
  router.put('/wardrobe',(req,res,next) => {
    try {
      const a = session(req); if (!a) { problem(res,401,'SESSION_REQUIRED','Sign in before saving your wardrobe.'); return; }
      if (req.body.workspaceId !== a.workspaceId) { problem(res,403,'ACCOUNT_CHANGED','The signed-in account changed. Sign in again before saving.'); return; }
      if (limited(req,res,writeLimit)) return;
      const revision = req.body.expectedRevision;
      if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) { problem(res,400,'BAD_INPUT','A valid wardrobe revision is required.'); return; }
      const pieces = validateWardrobe(req.body.pieces);
      const saved = wardrobe.save(a.workspaceId,revision,pieces);
      if (!saved) { problem(res,409,'REVISION_CONFLICT','This wardrobe changed in another window. Reload its latest version before saving.'); return; }
      res.json({ok:true,...saved});
    } catch(error) { next(error); }
  });
  router.use((error: unknown,_req:Request,res:Response,_next:express.NextFunction) => {
    if (error instanceof InvalidWardrobe) { problem(res,400,'INVALID_WARDROBE',error.message); return; }
    const type = (error as {type?:string})?.type;
    if (type === 'entity.too.large') { problem(res,413,'TOO_LARGE','This wardrobe is too large to save. Use smaller photos.'); return; }
    if (type === 'entity.parse.failed') { problem(res,400,'BAD_INPUT','The request is not valid JSON.'); return; }
    if ((error as {code?:string})?.code === 'ERR_SQLITE_ERROR' && String((error as Error).message).includes('UNIQUE constraint failed: accounts.handle')) {
      problem(res,409,'HANDLE_TAKEN','That handle is already registered.'); return;
    }
    problem(res,500,'SAVE_FAILED','The request could not be completed. Please try again.');
  });
  return {router,close:()=>{wardrobe.close();accounts.close();}};
}
