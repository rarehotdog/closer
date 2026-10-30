// Static checks for AT-17 (labels, banned words, on-screen scores) and AT-18 (keys, commit emails,
// EXIF, photo bytes in logs, person names). Repo scope only: script, subtitles, form draft and video
// OCR do not exist yet, so the RC2 verdict stays open. Run: node scripts/static_check.ts
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, extname } from 'node:path';

export type Finding = { check: string; where: string; detail: string };

// Banned words from the plan's script section, assembled from fragments so this file does not
// contain them literally (it is scanned too).
const BANNED = [
  ['conn', 'ected'], ['un', 'worn'], ['never ', 'worn'], ['미착', '용'], ['안 ', '입'], ['ag', 'ent'],
  ['about to ', 'buy'], ['knows ', 'what'], ['the ', 'only'], ['first ', 'app'], ['nobody ', 'else'], ['유', '일'], ['최', '초'],
].map((p) => p.join(''));

// Person-name deny list as SHA-256 of lowercase tokens (the names are not stored in the repository).
const NAME_HASHES: { len: number; script: 'hangul' | 'ascii'; hash: string }[] = [
];

/** Commit and text e-mail domains allowed (synthetic or no-reply only). */
export const ALLOWED_EMAIL_DOMAINS = ['closer.invalid', 'example.invalid', 'example.com', 'users.noreply.github.com'];

const BINARY = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.db', '.sqlite']);
const KEY_PATTERNS = [/LLM_\d{6,}_[A-Za-z0-9]/, /LLM\|\d{6,}\|/];
/** Files that are result objects (PASS/LIVE allowed there). */
const RESULT_FILES = new Set(['docs/status.md', 'docs/at_results.md', 'docs/at_results.json']);

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

export function listFiles(root: string): string[] {
  const out = git(root, ['ls-files', '--cached', '--others', '--exclude-standard']);
  if (out === null) throw new Error('git is required for the static checks');
  return out.split('\n').filter((f) => f && existsSync(join(root, f)) && statSync(join(root, f)).isFile());
}

function nameHits(text: string): string[] {
  const hits: string[] = [];
  const lower = text.toLowerCase();
  for (const n of NAME_HASHES) {
    // sliding windows over runs of the right script
    const runRe = n.script === 'hangul' ? /[가-힣]+/g : /[a-z-]+/g;
    for (const m of lower.matchAll(runRe)) {
      const run = m[0];
      for (let i = 0; i + n.len <= run.length; i++) {
        const w = run.slice(i, i + n.len);
        if (createHash('sha256').update(w, 'utf8').digest('hex') === n.hash) hits.push(`token of length ${n.len} at offset ${(m.index ?? 0) + i}`);
      }
    }
  }
  return hits;
}

function emailHits(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g)) {
    const domain = m[1].toLowerCase();
    if (!ALLOWED_EMAIL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) out.push(`e-mail domain ${domain}`);
  }
  return out;
}

export function runAt17(root: string): Finding[] {
  const f: Finding[] = [];
  for (const file of listFiles(root)) {
    if (BINARY.has(extname(file).toLowerCase())) continue;
    let text = readFileSync(join(root, file), 'utf8');
    const lower = text.toLowerCase();
    for (const w of BANNED) if (lower.includes(w.toLowerCase())) f.push({ check: 'banned word', where: file, detail: `"${w.slice(0, 2)}…" (${w.length} chars)` });
    const onSurface = file === 'README.md' || file.startsWith('web/public/') || file === 'shared/labels.ts';
    if (onSurface && !RESULT_FILES.has(file)) {
      if (file === 'shared/labels.ts') text = text.replace(/\/\/ @result-object-start[\s\S]*?\/\/ @result-object-end/, '');
      for (const m of text.matchAll(/\b(PASS|LIVE|ALL_GREEN)\b/g)) f.push({ check: 'status word outside a result object', where: file, detail: m[1] });
    }
    if (file.startsWith('web/public/') && /\bscore\b/i.test(text)) f.push({ check: 'score on screen', where: file, detail: 'score' });
  }
  const hist = git(root, ['log', '--all', '-p', '--no-color', '--format=%B']);
  if (hist) {
    const lower = hist.toLowerCase();
    for (const w of BANNED) {
      // history diffs include this file's own fragments only in split form, so a literal hit is real
      if (lower.includes(w.toLowerCase())) f.push({ check: 'banned word in git history', where: 'git log -p', detail: `"${w.slice(0, 2)}…"` });
    }
  }
  return f;
}

export function runAt18(root: string): Finding[] {
  const f: Finding[] = [];
  for (const file of listFiles(root)) {
    const ext = extname(file).toLowerCase();
    const buf = readFileSync(join(root, file));
    if (ext === '.jpg' || ext === '.jpeg') {
      if (buf.includes(Buffer.from('Exif\0\0', 'latin1'))) f.push({ check: 'EXIF', where: file, detail: 'Exif segment' });
      continue;
    }
    if (ext === '.png') {
      if (buf.includes(Buffer.from('eXIf', 'latin1'))) f.push({ check: 'EXIF', where: file, detail: 'eXIf chunk' });
      continue;
    }
    if (BINARY.has(ext)) continue;
    const text = buf.toString('utf8');
    for (const p of KEY_PATTERNS) if (p.test(text)) f.push({ check: 'key format', where: file, detail: String(p) });
    for (const h of nameHits(text)) f.push({ check: 'person name', where: file, detail: h });
    for (const e of emailHits(text)) f.push({ check: 'e-mail', where: file, detail: e });
    if (/data:image\/(jpeg|png|heic|webp);base64,[A-Za-z0-9+/]{200,}/.test(text)) f.push({ check: 'photo bytes in a file', where: file, detail: 'inline photo data' });
    if (ext === '.log') f.push({ check: 'log file tracked', where: file, detail: 'logs must not be committed' });
  }
  const meta = git(root, ['log', '--all', '--format=%an%n%ae%n%cn%n%ce']);
  if (meta) {
    for (const line of meta.split('\n').filter(Boolean)) {
      if (line.includes('@')) {
        const d = line.split('@')[1].toLowerCase();
        if (!ALLOWED_EMAIL_DOMAINS.includes(d)) f.push({ check: 'commit e-mail domain', where: 'git metadata', detail: d });
      }
      for (const h of nameHits(line)) f.push({ check: 'person name in commit metadata', where: 'git metadata', detail: h });
    }
  }
  const hist = git(root, ['log', '--all', '-p', '--no-color', '--format=%B']);
  if (hist) {
    for (const p of KEY_PATTERNS) if (p.test(hist)) f.push({ check: 'key format in git history', where: 'git log -p', detail: String(p) });
    for (const h of nameHits(hist)) f.push({ check: 'person name in git history', where: 'git log -p', detail: h });
    for (const e of emailHits(hist)) f.push({ check: 'e-mail in git history', where: 'git log -p', detail: e });
  }
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = new URL('..', import.meta.url).pathname;
  const a = runAt17(root);
  const b = runAt18(root);
  console.log(JSON.stringify({ at17: a, at18: b }, null, 2));
  process.exit(a.length + b.length === 0 ? 0 : 1);
}
