// Theme tokens of web/public/app.css (the white walk-in closet look). Every text colour pair the pages
// use stays at WCAG 4.5:1 or more and every control edge and focus ring at 3:1, in light and in dark;
// champagne brass never colours text; the two dark blocks (system setting, forced data-theme) agree;
// no font, image or stylesheet comes from outside the app (the CSP would refuse it).
import './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.ts';

const css = readFileSync(join(ROOT, 'web/public/app.css'), 'utf8');
const html = readFileSync(join(ROOT, 'web/public/index.html'), 'utf8');

/** Custom properties declared in the first block whose selector matches `head`: name → raw value. */
function block(head: RegExp): Map<string, string> {
  const m = head.exec(css);
  assert.ok(m, `token block ${head} is in app.css`);
  const start = m.index + m[0].length;
  const out = new Map<string, string>();
  for (const d of css.slice(start, css.indexOf('}', start)).matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(d[1], d[2].trim());
  return out;
}
const LIGHT = block(/^:root \{/m);
const DARK_SYSTEM = block(/:root:not\(\[data-theme="light"\]\) \{/);
const DARK_FORCED = block(/^:root\[data-theme="dark"\] \{/m);
const THEMES: [string, Map<string, string>][] = [['light', LIGHT], ['dark', new Map([...LIGHT, ...DARK_SYSTEM])]];

type Rgba = [number, number, number, number];
function color(t: Map<string, string>, name: string): Rgba {
  let v = t.get(name);
  for (let i = 0; v && i < 8; i++) { const ref = /^var\(--([a-z0-9-]+)\)$/.exec(v); if (!ref) break; v = t.get(ref[1]); }
  assert.ok(v, `--${name} is defined`);
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1) as Rgba;
  const rgba = /^rgba\(([^)]+)\)$/.exec(v);
  assert.ok(rgba, `--${name} is a hex or rgba colour (${v})`);
  return rgba[1].split(',').map(Number) as Rgba;
}
const over = (top: Rgba, under: Rgba): Rgba => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1) as Rgba;
const lum = (c: Rgba): number => {
  const [r, g, b] = c.slice(0, 3).map((v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: Rgba, b: Rgba): number => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

test('TH-01 text pairs reach 4.5:1 and control edges 3:1 in light and dark', () => {
  const text: [string, string][] = [
    ['ink', 'bg'], ['ink', 'surface'], ['ink', 'surface-2'], ['ink-2', 'bg'], ['ink-2', 'surface'], ['ink-2', 'surface-2'],
    ['ink-3', 'bg'], ['ink-3', 'surface'], ['ink-3', 'surface-2'], ['primary-ink', 'primary'], ['primary-ink', 'primary-hover'],
    ['accent', 'accent-soft'], ['bg', 'ink'], ['brass-ink', 'bg'], ['brass-ink', 'surface'],
    ['ok', 'ok-soft'], ['ok', 'surface'], ['warn', 'warn-soft'], ['warn', 'surface'], ['bad', 'bad-soft'], ['bad', 'surface'],
    ['ink-2', 'warn-soft'], ['ink-2', 'bad-soft'],
  ];
  const edge: [string, string][] = [['focus', 'bg'], ['focus', 'surface'], ['focus', 'surface-2'], ['line-strong', 'bg'], ['line-strong', 'surface'], ['line-strong', 'surface-2']];
  for (const [theme, t] of THEMES) {
    for (const [fg, bg] of text) {
      const r = ratio(color(t, fg), color(t, bg));
      assert.ok(r >= 4.5, `${theme}: --${fg} on --${bg} is ${r.toFixed(2)}:1, under 4.5:1`);
    }
    for (const [fg, bg] of edge) {
      const r = ratio(color(t, fg), color(t, bg));
      assert.ok(r >= 3, `${theme}: --${fg} against --${bg} is ${r.toFixed(2)}:1, under 3:1`);
    }
    // The frosted header and tab bar, over the page and over a primary button scrolling under them.
    for (const under of ['bg', 'primary']) {
      const glass = over(color(t, 'frost'), color(t, under));
      for (const fg of ['ink', 'ink-2']) {
        const r = ratio(color(t, fg), glass);
        assert.ok(r >= 4.5, `${theme}: --${fg} on --frost over --${under} is ${r.toFixed(2)}:1, under 4.5:1`);
      }
    }
  }
});

test('TH-02 champagne brass is ornament: no text colour is set in --brass or --trim', () => {
  assert.doesNotMatch(css, /(^|[^-])(color|fill):\s*var\(--(brass|trim)\)/m);
});

test('TH-03 the two dark blocks define the same tokens with the same values', () => {
  assert.ok(DARK_SYSTEM.size > 10, 'the dark block redefines the palette');
  assert.deepEqual([...DARK_FORCED.entries()].sort(), [...DARK_SYSTEM.entries()].sort());
});

test('TH-04 nothing loads from outside the app, and the browser bar has a theme colour for both schemes', () => {
  for (const [file, text] of [['app.css', css], ['index.html', html]]) {
    assert.doesNotMatch(text, /https?:\/\/|url\(\s*['"]?\/\//, `${file} names no outside address`);
  }
  assert.match(html, /<meta name="theme-color" content="#[0-9a-f]{6}" media="\(prefers-color-scheme: light\)">/);
  assert.match(html, /<meta name="theme-color" content="#[0-9a-f]{6}" media="\(prefers-color-scheme: dark\)">/);
});
