// Links a model cited, sorted by resale platform. A link is a place for the owner to look, never a
// price: the owner opens it, reads the price there and enters it as evidence themselves. Nothing
// here fetches a page or reads a number from one.
import { PLATFORM_INFO, type Platform } from './market.ts';
import type { WonderResult } from '../adapters/wonder.ts';

export type LinkPlatform = Platform | 'OTHER';
export type EvidenceLink = { url: string; title: string | null; host: string; platform: LinkPlatform; platformName: string; cited: boolean };

const HOSTS: [RegExp, Platform][] = [
  [/(^|\.)kream\.co\.kr$/, 'KREAM'],
  [/(^|\.)(daangn\.com|karrotmarket\.com)$/, 'KARROT'],
  [/(^|\.)bunjang\.co\.kr$/, 'BUNJANG'],
  [/(^|\.)poshmark\.(com|ca|com\.au|in)$/, 'POSHMARK'],
  [/(^|\.)ebay\.[a-z.]+$/, 'EBAY'],
  [/(^|\.)grailed\.com$/, 'GRAILED'],
  [/(^|\.)depop\.com$/, 'DEPOP'],
  [/(^|\.)vinted\.[a-z.]+$/, 'VINTED'],
];

export function platformOfUrl(url: string): { host: string; platform: LinkPlatform } | null {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    host = u.hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const [re, p] of HOSTS) if (re.test(host)) return { host, platform: p };
  return { host, platform: 'OTHER' };
}

/** Citations first (the sources the model used), then the other search results; https only; one row per url. */
export function evidenceLinks(r: Pick<WonderResult, 'citations' | 'searchResults'>): EvidenceLink[] {
  const out: EvidenceLink[] = [];
  const seen = new Set<string>();
  const add = (url: string, title: string | null, cited: boolean) => {
    if (seen.has(url)) return;
    const p = platformOfUrl(url);
    if (!p) return;
    seen.add(url);
    out.push({ url, title, host: p.host, platform: p.platform, platformName: p.platform === 'OTHER' ? p.host : PLATFORM_INFO[p.platform].name, cited });
  };
  for (const c of r.citations) add(c.url, c.title, true);
  for (const s of r.searchResults) add(s.url, s.title, false);
  return out;
}
