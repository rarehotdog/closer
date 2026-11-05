import { basename, resolve } from 'node:path';

// Vite normally serves source files. Account storage must never be a source asset.
export const PRIVATE_FILE_PATTERNS = [
  '**/.env', '**/.env.*', '**/*.{crt,pem}', '**/.git/**', '**/.data/**',
  '**/*.{db,sqlite,sqlite3}', '**/*.{db,sqlite,sqlite3}-{wal,shm,journal}',
];
export const accountDatabasePath = () => resolve(process.env.CLOSER_ACCOUNT_DB ?? '../../.data/rail-studio.sqlite');

export function isPrivateFileRequest(url: string, databasePath: string): boolean {
  let pathname = url.split('?')[0];
  try { for (let i = 0; i < 3; i++) pathname = decodeURIComponent(pathname); }
  catch { return true; }
  pathname = pathname.replace(/\\/g, '/');
  const lower = pathname.toLowerCase();
  if (/(?:^|\/)\.(?:data|git)(?:\/|$)/.test(lower) || /(?:^|\/)\.env(?:\.|\/|$)/.test(lower)) return true;
  if (/\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?(?:\/|$)/.test(lower)) return true;
  const absolute = resolve(databasePath).replace(/\\/g, '/');
  const filename = basename(absolute).toLowerCase();
  const resolved = resolve(process.cwd(), `.${pathname}`).replace(/\\/g, '/');
  return ['', '-wal', '-shm', '-journal'].some(suffix =>
    pathname.includes(absolute + suffix) || resolved === absolute + suffix ||
    lower.split('/').includes(filename + suffix));
}
