// Request guards for web/server.ts: per-address token buckets, constant-time token checks, strict
// JSON bodies and the security headers every response carries. In-process state only (a restart
// empties the buckets), which is enough for one server behind one reverse proxy.
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export type Json = Record<string, unknown>;

/** A request the server refuses before any handler runs; `status` is the HTTP status to answer with. */
export class BadRequest extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Token bucket per key: `limit` requests per `windowMs`, refilled continuously, so a burst of
 * `limit` is allowed and then one request per `windowMs / limit`.
 */
export class RateLimiter {
  readonly limit: number;
  readonly windowMs: number;
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Takes one token for `key`. Returns null when allowed, otherwise the milliseconds until the next token. */
  take(key: string, nowMs = Date.now()): number | null {
    if (this.buckets.size > 10_000) this.prune(nowMs);
    const b = this.buckets.get(key) ?? { tokens: this.limit, at: nowMs };
    b.tokens = Math.min(this.limit, b.tokens + (Math.max(0, nowMs - b.at) * this.limit) / this.windowMs);
    b.at = nowMs;
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return null;
    }
    return Math.ceil(((1 - b.tokens) * this.windowMs) / this.limit);
  }

  /** Forgets keys whose bucket is full again (bounded memory under many addresses). */
  prune(nowMs = Date.now()): void {
    for (const [k, b] of this.buckets) {
      if (b.tokens + (Math.max(0, nowMs - b.at) * this.limit) / this.windowMs >= this.limit) this.buckets.delete(k);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}

/**
 * The address a request came from. The socket address by default; with `trustProxy` (set only when
 * a reverse proxy such as the deploy kit's Caddy is the one peer that can reach the server) the
 * last X-Forwarded-For entry, which is the one that proxy wrote.
 */
export function clientIp(req: Pick<IncomingMessage, 'headers' | 'socket'>, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const raw = Array.isArray(xff) ? xff[xff.length - 1] : xff;
    const last = raw?.split(',').pop()?.trim();
    if (last) return last;
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

/** Constant-time comparison of a header value with the configured token; false for any missing side. */
export function tokenMatches(given: string | string[] | undefined, expected: string | undefined): boolean {
  if (typeof given !== 'string' || !expected) return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Reads a POST body as one JSON object. Refuses anything that is not declared application/json
 * (415: a cross-site form or text/plain request never reaches a handler), bodies over `limit`
 * (413) and bodies that are not a JSON object (400) — without echoing parser text.
 */
export async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<Json> {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new BadRequest(415, 'Content-Type must be application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new BadRequest(413, `body over ${limit} bytes`);
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BadRequest(400, 'invalid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BadRequest(400, 'body must be a JSON object');
  return parsed as Json;
}

/**
 * Content Security Policy for the pages: scripts, styles and modules from this origin only (the
 * vendored three.js module is served from /static/vendor), images also from data: URLs (the
 * code-drawn sample photos, uploaded photos as data URLs) and blob: URLs (owner photos fetched for
 * the 3D closet). Inline styles are set through the CSSOM (element.style), which the policy allows.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Headers on every response, pages and API alike. The camera is the photo input on My wardrobe. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
};
