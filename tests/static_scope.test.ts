import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAt17, runAt18 } from '../scripts/static_check.ts';

const forbidden = ['ag', 'ent'].join('');
const technical = [['ag', 'ent-base'], ['https-proxy-', 'ag', 'ent']].map(parts => parts.join(''));
const secret = ['LL', 'M_', '123456789_', 'a'].join('');
const email = ['fixture', '@', 'private', '.invalid'].join('');
function fixture(run: (root: string, commit: () => void) => void) {
  const root = mkdtempSync(join(tmpdir(), 'closer-static-scope-'));
  const git = (...args: string[]) => execFileSync('git', args, {cwd:root,stdio:'ignore'});
  try {
    git('init'); git('config','user.name','Build'); git('config','user.email','build@closer.invalid');
    run(root, () => {git('add','.');git('commit','-m','Static fixture');});
  } finally {rmSync(root,{recursive:true,force:true});}
}

test('AT-17 permits the two exact technical tokens in text and history', () => fixture((root,commit) => {
  writeFileSync(join(root,'package-lock.json'),JSON.stringify({dependencies:technical, resolved:technical.map(name=>`https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`)}));
  assert.deepEqual(runAt17(root),[]); commit();
  writeFileSync(join(root,'package-lock.json'),'{}');
  assert.deepEqual(runAt17(root),[]); assert.deepEqual(runAt18(root),[]);
}));

test('AT-17 still detects plain forbidden text and non-token substrings', () => fixture((root) => {
  writeFileSync(join(root,'package-lock.json'),`${technical.join(' ')} ${forbidden}`);
  assert(runAt17(root).some(f=>f.check==='banned word'));
  writeFileSync(join(root,'package-lock.json'),`x${technical[0]} ${technical[1]}x`);
  assert(runAt17(root).some(f=>f.check==='banned word'));
}));

test('AT-18 still scans raw technical-token files for keys and e-mail', () => fixture((root) => {
  writeFileSync(join(root,'package-lock.json'),`${technical.join(' ')} ${secret} ${email}`);
  assert.deepEqual(runAt17(root),[]);
  const hits=runAt18(root);
  assert(hits.some(f=>f.check==='key format')); assert(hits.some(f=>f.check==='e-mail'));
}));

test('history retains forbidden-text and raw key/e-mail detection after current cleanup', () => fixture((root,commit) => {
  writeFileSync(join(root,'package-lock.json'),`${technical.join(' ')} ${forbidden} ${secret} ${email}`); commit();
  writeFileSync(join(root,'package-lock.json'),'{}'); commit();
  assert(runAt17(root).some(f=>f.check==='banned word in git history'));
  const hits=runAt18(root);
  assert(hits.some(f=>f.check==='key format in git history')); assert(hits.some(f=>f.check==='e-mail in git history'));
  assert(!hits.some(f=>f.check==='commit e-mail domain'));
}));
