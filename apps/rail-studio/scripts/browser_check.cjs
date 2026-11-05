// Browser smoke check for the AI Studio version of Closer, against a running server.
//   BASE=http://localhost:3000 node scripts/browser_check.cjs [out-dir]
// Runs the main screens at 1440x900 and 390x844 and reports, per screen: console errors,
// horizontal overflow, banned words in the page text, and any percentage strings (to spot a
// probability creeping back in). Writes screenshots to out-dir (default .data/shots).
// Needs playwright with chromium; this environment has it preinstalled.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const BASE = (process.env.BASE || 'http://localhost:3000').replace(/\/$/, '');
const OUT = process.argv[2] || path.join('.data', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const BANNED = [['conn', 'ected'], ['un', 'worn'], ['never ', 'worn'], ['미착', '용'], ['안 ', '입'], ['ag', 'ent'], ['about to ', 'buy'], ['knows ', 'what'], ['the ', 'only'], ['first ', 'app'], ['nobody ', 'else'], ['유', '일'], ['최', '초']].map(parts => parts.join(''));
const SCREENS = [
  ['home', '/?scan=0', 'canvas'],
  ['inspector', '/?scan=0&piece=J2', '[data-testid=inspector-actions], [data-testid=verifiable-loop-strip]'],
  ['grid', '/?scan=0&layout=grid', '[data-testid=closet-grid]'],
  ['force2d', '/?scan=0&force2d=1', '[data-testid=closet-grid]'],
  ['review', '/?scan=0&layout=review', '[data-testid=review-mode]'],
  ['scan', '/?scan=1', '[data-testid=scan-kind]'],
];

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const results = [];
  for (const [vpName, vp] of [['1440', { width: 1440, height: 900 }], ['390', { width: 390, height: 844 }]]) {
    for (const [name, route, waitFor] of SCREENS) {
      const ctx = await browser.newContext({ viewport: vp });
      const page = await ctx.newPage();
      const errs = [];
      page.on('pageerror', (e) => errs.push(String(e)));
      page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
      let ok = true;
      try {
        await page.goto(BASE + route, { waitUntil: 'load' });
        await page.waitForSelector(waitFor, { timeout: 30000 });
        await page.waitForTimeout(name === 'home' ? 5000 : 1500);
      } catch (e) {
        ok = false;
        errs.push('wait failed: ' + String(e).slice(0, 120));
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth).catch(() => -1);
      const text = await page.evaluate(() => document.body.innerText).catch(() => '');
      const lower = text.toLowerCase();
      const banned = BANNED.filter((w) => lower.includes(w));
      const percents = (text.match(/\d+(?:\.\d+)?%/g) || []).slice(0, 10);
      await page.screenshot({ path: path.join(OUT, `${name}-${vpName}.png`) }).catch(() => {});
      results.push({ screen: name, viewport: vpName, ok, overflow, banned, percents, errors: errs.slice(0, 5) });
      await ctx.close();
    }
  }
  await browser.close();
  console.log(JSON.stringify(results, null, 1));
  const bad = results.filter((r) => !r.ok || r.overflow !== 0 || r.banned.length || r.errors.length);
  console.log(`\n${results.length - bad.length} of ${results.length} screens clean (0 errors, 0 overflow, 0 banned words)`);
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
