// Screenshots of the five screens (and the Try flow states) into docs/screens/.
// Starts its own server on a fresh mock DB, drives Chromium with Playwright, then stops the server.
// Run: npm run screens   (needs Playwright with Chromium installed locally; not a project dependency)
const { spawn } = require('node:child_process');
const { mkdirSync, rmSync } = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screens');
const PORT = 8799;
const BASE = `http://localhost:${PORT}`;
const DB = path.join(ROOT, '.data', 'screens.db');

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/api/version`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server did not start');
}

(async () => {
  mkdirSync(OUT, { recursive: true });
  for (const suf of ['', '-wal', '-shm']) rmSync(DB + suf, { force: true });
  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'web/server.ts'], {
    cwd: ROOT,
    env: { ...process.env, CLOSER_MODE: 'mock', CLOSER_PORT: String(PORT), CLOSER_DB_PATH: DB, CLOSER_TODAY: '2026-10-31', MODEL_API_KEY: '' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const shots = [];
  try {
    await waitForServer();
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light' });
    const shot = async (name) => {
      const file = path.join(OUT, name);
      await page.screenshot({ path: file, fullPage: true });
      shots.push(path.relative(ROOT, file));
    };
    const ready = () => page.waitForSelector('body[data-ready="1"]');
    const flashHas = (text) => page.waitForFunction((t) => (document.querySelector('#flash')?.textContent || '').includes(t), text);

    // 1 · Try
    await page.goto(`${BASE}/try`);
    await ready();
    await shot('01-try-pick.png');
    await page.click('#run');
    await page.waitForSelector('#stage[data-painted="1"]');
    await page.waitForTimeout(200);
    await shot('02-try-masks-cards.png');
    await page.click('#confirm');
    await flashHas('read back');
    await page.click('#propose');
    await page.waitForSelector('#options');
    await page.waitForTimeout(300);
    await shot('03-try-options.png');
    await page.click('[data-pick="0"]');
    await flashHas('Selection saved');
    await page.click('button[data-item="B2"][data-state="LAUNDRY"]');
    await page.waitForFunction(() => document.querySelector('#decision h2')?.textContent.includes('re-plan'));
    await page.waitForTimeout(300);
    await shot('04-try-laundry-replan.png');
    await page.click('[data-pick="0"]');
    await flashHas('Selection saved');
    await page.click('#wore');
    await flashHas('+1 wear');
    await page.click('#wore');
    await flashHas('Already recorded');
    await page.waitForTimeout(200);
    await shot('05-try-wear-recorded.png');
    await page.click('#next');
    await page.waitForFunction(() => document.querySelector('#decision h2')?.textContent.includes('Next plan'));
    await page.waitForTimeout(300);
    await shot('06-try-next-plan.png');

    // 2 · App (owner)
    await page.goto(`${BASE}/app`);
    await ready();
    await page.waitForSelector('#wardrobe');
    await shot('07-app.png');

    // 3 · Recorded run (read-only)
    await page.goto(`${BASE}/w/demo-rc1`);
    await ready();
    await page.click('#try-write');
    await page.waitForFunction(() => (document.querySelector('#write-result')?.textContent || '').length > 0);
    await shot('08-recorded-run-readonly.png');

    // 4 · Admin, then K1 on → Try run is held with META_DISABLED
    await page.goto(`${BASE}/admin`);
    await ready();
    await shot('09-admin.png');
    await page.click('#kill-on');
    await page.waitForSelector('#kill-state');
    await page.waitForFunction(() => document.querySelector('#kill-state')?.textContent.startsWith('on'));
    await shot('10-admin-k1-on.png');
    await page.goto(`${BASE}/try`);
    await ready();
    await page.click('#run');
    await page.waitForFunction(() => document.querySelector('#op-state')?.textContent === 'HOLD');
    await shot('11-try-k1-held.png');
    await fetch(`${BASE}/api/admin/kill`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"on":false}' });

    // 5 · Version
    await page.goto(`${BASE}/version`);
    await ready();
    await shot('12-version.png');

    // Phone width check (Try)
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    await phone.goto(`${BASE}/try`);
    await phone.waitForSelector('body[data-ready="1"]');
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await phone.screenshot({ path: path.join(OUT, '13-try-phone.png'), fullPage: true });
    shots.push('docs/screens/13-try-phone.png');
    console.log(`phone horizontal overflow px: ${overflow}`);

    await browser.close();
    console.log(shots.join('\n'));
  } finally {
    server.kill();
    for (const suf of ['', '-wal', '-shm']) rmSync(DB + suf, { force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
