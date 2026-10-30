// Canonical JSON for stateHash (§3-6): sorted keys, no whitespace, integers only, NFC strings.
import { createHash } from 'node:crypto';

export function canonicalize(v: unknown): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isInteger(v)) throw new Error(`canonical JSON allows integers only, got ${v}`);
      return String(v);
    case 'string':
      return JSON.stringify(v.normalize('NFC'));
    case 'object': {
      if (Array.isArray(v)) return `[${v.map(canonicalize).join(',')}]`;
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .map((k) => [k.normalize('NFC'), k] as const)
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      return `{${keys.map(([nk, k]) => `${JSON.stringify(nk)}:${canonicalize(obj[k])}`).join(',')}}`;
    }
    default:
      throw new Error(`canonical JSON: unsupported type ${typeof v}`);
  }
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function canonicalHash(v: unknown): string {
  return sha256Hex(canonicalize(v));
}
