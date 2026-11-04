// Call Muse Wonder (or Muse Spark, by model id) directly from the command line with the owner's key.
//
//   node scripts/wonder.ts --prompt "…"                           # dry run: prints the request, sends nothing
//   npm run wonder -- --prompt "…" [--search] [--image ./x.jpg]   # live: key from the Keychain via scripts/with-key.sh
//
// Options
//   --prompt TEXT | --prompt-file PATH      the user message (required)
//   --instructions TEXT | --instructions-file PATH
//   --image PATH                            up to 4 images (jpeg, png, webp, gif), sent as data URLs
//   --schema PATH.json                      {"name": "...", "schema": {...}} → strict JSON output, parsed
//   --search [--country KR] [--context low|medium|high]   web search grounding with url citations
//   --effort minimal|low|medium|high|max    reasoning effort (default medium)
//   --max-tokens N                          default 2000, at most 8000
//   --model muse-wonder-1.0|muse-spark-1.3  default muse-wonder-1.0
//   --previous RESPONSE_ID                  follow-up turn (the earlier call must have used --store)
//   --store                                 let the server keep this response for a follow-up turn
//   --out PATH                              write the full result JSON to a file
//
// Prints the answer, citations, function calls, usage and cost. Appends one line per live call to
// .data/wonder_calls.jsonl with status, timing, usage, cost, search count and response id — never the
// key, never the prompt, never the answer. Nothing is written to any wardrobe.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { createRealTransport, DEFAULT_BASE_URL } from '../adapters/transport.ts';
import { buildWonderBody, createWonderPort, WONDER_EST_MICRO_USD, WONDER_MODEL, wonderRequestFromJson } from '../adapters/wonder.ts';
import type { CallDeps } from '../adapters/responses.ts';
import { evidenceLinks } from '../engine/links.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const args = process.argv.slice(2);
const live = args.includes('--live');

function opt(name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
function opts(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length - 1; i++) if (args[i] === name) out.push(args[i + 1]);
  return out;
}
const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

function imageDataUrl(path: string): string {
  const mime = MIME[extname(path).toLowerCase()];
  if (!mime) throw new Error(`${path}: use jpeg, png, webp or gif`);
  const bytes = readFileSync(path);
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`${path}: ${bytes.length} bytes; keep images under ${MAX_IMAGE_BYTES} bytes`);
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

function textOrFile(flag: string): string | null {
  const direct = opt(flag);
  if (direct !== null) return direct;
  const file = opt(`${flag}-file`);
  return file ? readFileSync(file, 'utf8') : null;
}

function redacted(body: Record<string, unknown>): unknown {
  const copy = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  for (const m of (copy.input as Record<string, unknown>[]) ?? []) {
    for (const c of (m.content as Record<string, unknown>[]) ?? []) {
      if (c.type === 'input_image' && typeof c.image_url === 'string' && c.image_url.startsWith('data:')) c.image_url = `${c.image_url.slice(0, c.image_url.indexOf(',') + 1)}… (${c.image_url.length} chars)`;
    }
  }
  return copy;
}

async function main() {
  const raw: Record<string, unknown> = { prompt: textOrFile('--prompt') ?? '' };
  const instructions = textOrFile('--instructions');
  if (instructions) raw.instructions = instructions;
  const images = opts('--image');
  if (images.length) raw.images = images.map(imageDataUrl);
  const schemaPath = opt('--schema');
  if (schemaPath) raw.schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  if (args.includes('--search')) {
    const ws: Record<string, unknown> = {};
    const country = opt('--country');
    if (country) ws.userLocation = { country };
    const ctx = opt('--context');
    if (ctx) ws.contextSize = ctx;
    raw.webSearch = Object.keys(ws).length ? ws : true;
  }
  for (const [flag, key] of [['--effort', 'reasoning'], ['--model', 'model'], ['--previous', 'previousResponseId']] as const) {
    const v = opt(flag);
    if (v !== null) raw[key] = v;
  }
  const maxTokens = opt('--max-tokens');
  if (maxTokens !== null) raw.maxOutputTokens = Number(maxTokens);
  if (args.includes('--store')) raw.store = true;

  const req = wonderRequestFromJson(raw);
  if (typeof req === 'string') {
    console.error(`request refused: ${req}`);
    process.exit(64);
  }
  const body = buildWonderBody(req);
  const base = (process.env.META_API_BASE_URL ?? '').trim() || DEFAULT_BASE_URL;
  console.log(`Muse Wonder call · base ${base} · model ${body.model} · est. ≤ $${(WONDER_EST_MICRO_USD / 1e6).toFixed(3)} per call (+ $0.0025 per search query, + retries)`);
  if (body.model === WONDER_MODEL) console.log('Note (dev.meta.ai/docs/models, read 2026-11-04): Muse Wonder is in preview and not available in South Korea on the Model API; a 401/403 or 404 here is the place to retry with --model muse-spark-1.3.');
  if (!live) {
    console.log('Dry run. Nothing sent. Request body (images redacted):');
    console.log(JSON.stringify(redacted(body), null, 2));
    console.log('Add --live with MODEL_API_KEY in the environment, or run: npm run wonder -- <same options>');
    return;
  }
  const transport = createRealTransport(process.env); // throws without a key; never logs it
  const deps: CallDeps = { transport, source: 'live', sleep: (ms) => new Promise((r) => setTimeout(r, ms)), nowMs: () => performance.now(), nowIso: () => new Date().toISOString() };
  const port = createWonderPort(deps);
  const t0 = performance.now();
  const r = await port.ask(req);
  const ms = Math.round(performance.now() - t0);
  const calls = r.calls.map((c) => ({ callId: c.callId, model: c.model, http: c.http, latencyMs: c.latencyMs, usage: c.usage, costMicroUsd: c.costMicroUsd }));
  mkdirSync(join(ROOT, '.data'), { recursive: true });
  const record = {
    at: new Date().toISOString(), model: body.model, ok: r.ok, http: r.ok ? calls[calls.length - 1]?.http ?? null : r.http, code: r.ok ? null : r.code,
    latencyMs: ms, attempts: calls.length, usage: calls[calls.length - 1]?.usage ?? null, costMicroUsd: calls.reduce((s, c) => s + c.costMicroUsd, 0),
    searchCalls: r.ok ? r.value.searchCalls : null, responseId: r.ok ? r.value.responseId : null, search: Boolean(req.webSearch), images: req.images?.length ?? 0, schema: Boolean(req.schema),
  };
  appendFileSync(join(ROOT, '.data', 'wonder_calls.jsonl'), `${JSON.stringify(record)}\n`);
  if (!r.ok) {
    console.error(`HOLD · ${r.code} · ${r.detail} · attempts ${calls.length} · ${ms} ms`);
    process.exit(1);
  }
  const v = r.value;
  console.log(`\n${v.text ?? '(no text)'}\n`);
  if (v.json !== null) console.log(`JSON (schema ${req.schema?.name}):\n${JSON.stringify(v.json, null, 2)}\n`);
  if (v.functionCalls.length) console.log(`Function calls:\n${v.functionCalls.map((f) => `  ${f.name}(${f.arguments}) · call_id ${f.callId}`).join('\n')}\n`);
  const links = evidenceLinks(v);
  if (links.length) console.log(`Links (${v.citations.length} cited, ${v.searchResults.length} considered):\n${links.map((l) => `  ${l.cited ? '*' : ' '} ${l.platformName} · ${l.title ?? ''} · ${l.url}`).join('\n')}\n`);
  console.log(`response ${v.responseId ?? '(no id)'} · ${v.model || body.model} · ${ms} ms · attempts ${calls.length} · usage ${v.usage ? `${v.usage.inputTokens} in / ${v.usage.outputTokens} out` : 'not reported (charged at the estimate)'} · search queries ${v.searchCalls} · cost $${(record.costMicroUsd / 1e6).toFixed(4)}`);
  const out = opt('--out');
  if (out) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(out, JSON.stringify({ request: redacted(body), result: v, calls }, null, 2));
    console.log(`full result written to ${out}`);
  }
  console.log('record appended to .data/wonder_calls.jsonl (statuses, timings, usage, cost; no prompt, no answer, no key)');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
