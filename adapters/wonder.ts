// 미검증 — 문서 예시 기반, 실호출 0
// Muse Wonder (muse-wonder-1.0, preview) on the same Responses API as Spark: one general "ask" port
// that the engine, the server and scripts/wonder.ts share. Text, images, a strict JSON schema,
// function tools, web search grounding with url citations, and a follow-up turn through
// previous_response_id. dev.meta.ai/docs/models (read 2026-11-04): "Both take the same requests on
// the same endpoints, so switching is a model ID change", and "Muse Wonder and Muse Wonder Full
// aren't currently available in South Korea, on Model API or in Muse Code" — so the model id is a
// parameter and every request can run on muse-spark-1.3 unchanged.
import { callResponses, functionCalls, outputText, parseJsonOutput, readUsage, SPARK_MODEL, sparkCostMicroUsd, type CallDeps } from './responses.ts';
import { statusToReason } from '../engine/retry.ts';
import type { CallDraft, PortResult } from './types.ts';

export const WONDER_MODEL = 'muse-wonder-1.0';
export const WONDER_MODELS = [WONDER_MODEL, SPARK_MODEL] as const;
export type WonderModel = (typeof WONDER_MODELS)[number];

/** dev.meta.ai/docs/pricing-rate-limits (read 2026-11-04): Wonder Standard $4.00 / 1M input, $20.00 / 1M output; web search $2.50 / 1,000 queries. */
export function wonderCostMicroUsd(u: { inputTokens: number; outputTokens: number } | null, fallbackMicroUsd: number): number {
  if (!u || !Number.isFinite(u.inputTokens) || !Number.isFinite(u.outputTokens)) return fallbackMicroUsd;
  return Math.round(u.inputTokens * 4 + u.outputTokens * 20);
}
export const WEB_SEARCH_MICRO_USD = 2_500;
/** Cap pre-check estimate: about 4k input + 1.5k output tokens on Wonder plus one search (≈ $0.05). */
export const WONDER_EST_MICRO_USD = 50_000;

export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export const MAX_PROMPT_CHARS = 4000;
export const MAX_IMAGES = 4;
export const MAX_OUTPUT_TOKENS = 8000;

export type FunctionTool = { name: string; description: string; parameters: Record<string, unknown>; strict?: boolean };
export type WebSearchOptions = {
  contextSize?: 'low' | 'medium' | 'high';
  /** Approximate location, the shape the search-grounding doc shows (country is an ISO 3166-1 code). */
  userLocation?: { country?: string; region?: string; city?: string; timezone?: string };
};

export type WonderRequest = {
  prompt: string;
  instructions?: string | null;
  /** data: or https: image URLs; images go into the user message, as the image-understanding doc shows. */
  images?: string[];
  schema?: { name: string; schema: Record<string, unknown> } | null;
  tools?: FunctionTool[];
  webSearch?: boolean | WebSearchOptions;
  reasoning?: ReasoningEffort;
  maxOutputTokens?: number;
  /** Follow-up turn: needs the earlier response to have been sent with store: true. */
  previousResponseId?: string | null;
  toolOutputs?: { callId: string; output: string }[];
  /** store: false by default (the docs' Standard mode keeps nothing); true only when a follow-up turn is planned. */
  store?: boolean;
  model?: WonderModel;
};

export type Citation = { url: string; title: string | null };
export type SearchResult = { url: string; title: string | null; snippet: string | null };
export type WonderResult = {
  responseId: string | null;
  model: string;
  text: string | null;
  /** Parsed output when a schema was requested; otherwise null. */
  json: unknown;
  functionCalls: { name: string; arguments: string; callId: string }[];
  /** url_citation annotations, deduplicated by url, in the order they appear. */
  citations: Citation[];
  /** web_search_call.results when `include` asked for them (every source considered, cited or not). */
  searchResults: SearchResult[];
  searchCalls: number;
  usage: CallDraft['usage'];
};

export function buildWonderBody(req: WonderRequest): Record<string, unknown> {
  const model = req.model ?? WONDER_MODEL;
  const content: Record<string, unknown>[] = [{ type: 'input_text', text: req.prompt }];
  for (const url of req.images ?? []) content.push({ type: 'input_image', image_url: url });
  const input: Record<string, unknown>[] = [];
  if (req.instructions) input.push({ type: 'message', role: 'system', content: [{ type: 'input_text', text: req.instructions }] });
  input.push({ type: 'message', role: 'user', content });
  for (const t of req.toolOutputs ?? []) input.push({ type: 'function_call_output', call_id: t.callId, output: t.output });
  const tools: Record<string, unknown>[] = [];
  if (req.webSearch) {
    const o = typeof req.webSearch === 'object' ? req.webSearch : {};
    const tool: Record<string, unknown> = { type: 'web_search' };
    if (o.contextSize) tool.search_context_size = o.contextSize;
    if (o.userLocation) tool.user_location = { type: 'approximate', ...o.userLocation };
    tools.push(tool);
  }
  for (const f of req.tools ?? []) tools.push({ type: 'function', name: f.name, description: f.description, parameters: f.parameters, strict: f.strict ?? true });
  const body: Record<string, unknown> = {
    model,
    store: req.store === true,
    reasoning: { effort: req.reasoning ?? 'medium' },
    max_output_tokens: Math.min(MAX_OUTPUT_TOKENS, Math.max(16, Math.round(req.maxOutputTokens ?? 2000))),
    input,
  };
  if (req.schema) body.text = { format: { type: 'json_schema', name: req.schema.name, schema: req.schema.schema, strict: true } };
  if (tools.length) body.tools = tools;
  // One function call per turn (code checks each one); only takes effect when function tools are present (tool-calling doc).
  if (req.tools?.length) body.parallel_tool_calls = false;
  if (req.webSearch) body.include = ['web_search_call.results'];
  if (req.previousResponseId) body.previous_response_id = req.previousResponseId;
  return body;
}

/** Read a Responses API result the way the search-grounding and tool-calling docs describe it. */
export function parseWonderResponse(json: unknown, wantJson: boolean): WonderResult {
  const root = (json ?? {}) as Record<string, unknown>;
  const out = Array.isArray(root.output) ? (root.output as Record<string, unknown>[]) : [];
  const citations: Citation[] = [];
  const seen = new Set<string>();
  const searchResults: SearchResult[] = [];
  let searchCalls = 0;
  for (const item of out) {
    if (item?.type === 'web_search_call') {
      searchCalls++;
      for (const r of Array.isArray(item.results) ? (item.results as Record<string, unknown>[]) : []) {
        if (typeof r?.url === 'string') searchResults.push({ url: r.url, title: typeof r.title === 'string' ? r.title : null, snippet: typeof r.snippet === 'string' ? r.snippet : null });
      }
      continue;
    }
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const c of item.content as Record<string, unknown>[]) {
      for (const a of Array.isArray(c?.annotations) ? (c.annotations as Record<string, unknown>[]) : []) {
        if (a?.type === 'url_citation' && typeof a.url === 'string' && !seen.has(a.url)) {
          seen.add(a.url);
          citations.push({ url: a.url, title: typeof a.title === 'string' ? a.title : null });
        }
      }
    }
  }
  const text = outputText(json);
  const parsed = wantJson && text !== null ? parseJsonOutput(text) : null;
  return {
    responseId: typeof root.id === 'string' ? root.id : null,
    model: typeof root.model === 'string' ? root.model : '',
    text,
    json: parsed,
    functionCalls: functionCalls(json),
    citations,
    searchResults,
    searchCalls,
    usage: readUsage(json),
  };
}

export interface WonderPort {
  ask(req: WonderRequest): Promise<PortResult<WonderResult>>;
}

export function createWonderPort(deps: CallDeps): WonderPort {
  return {
    async ask(req) {
      const body = buildWonderBody(req);
      const model = String(body.model);
      const price = model === WONDER_MODEL ? wonderCostMicroUsd : sparkCostMicroUsd;
      const { outcome, calls } = await callResponses(deps, body, { model, estMicroUsd: WONDER_EST_MICRO_USD, price: (u) => price(u, WONDER_EST_MICRO_USD) });
      const f = outcome.final;
      if (!f || f.status < 200 || f.status >= 300) {
        const status = f?.status ?? 0;
        return { ok: false, http: status, code: statusToReason(status), detail: `${model} HTTP ${status}${status === 401 || status === 403 ? ' (check the key and whether the model is available for this team)' : ''}`, calls };
      }
      let value: WonderResult;
      try {
        value = parseWonderResponse(f.json, Boolean(req.schema));
      } catch (e) {
        return { ok: false, http: f.status, code: 'INVALID_MODEL_OUTPUT', detail: e instanceof Error ? e.message : String(e), calls };
      }
      if (value.text === null && value.functionCalls.length === 0) return { ok: false, http: f.status, code: 'INVALID_MODEL_OUTPUT', detail: 'no output_text and no function call', calls };
      // Search queries are billed per query on top of tokens; the row that carried the answer carries them.
      if (deps.source === 'live' && value.searchCalls > 0 && calls.length) calls[calls.length - 1].costMicroUsd += value.searchCalls * WEB_SEARCH_MICRO_USD;
      return { ok: true, value, calls };
    },
  };
}

/** Validate a request that arrived as JSON (server or CLI). Returns a message when something is off. */
export function wonderRequestFromJson(x: unknown): WonderRequest | string {
  const b = (x ?? {}) as Record<string, unknown>;
  const prompt = String(b.prompt ?? '').trim();
  if (!prompt) return 'prompt is required';
  if (prompt.length > MAX_PROMPT_CHARS) return `prompt must be at most ${MAX_PROMPT_CHARS} characters`;
  const req: WonderRequest = { prompt };
  if (b.instructions !== undefined && b.instructions !== null) {
    if (typeof b.instructions !== 'string') return 'instructions must be text';
    req.instructions = b.instructions.slice(0, MAX_PROMPT_CHARS);
  }
  if (b.images !== undefined) {
    if (!Array.isArray(b.images) || b.images.length > MAX_IMAGES) return `images must be a list of at most ${MAX_IMAGES}`;
    for (const u of b.images) if (typeof u !== 'string' || !(u.startsWith('data:image/') || u.startsWith('https://'))) return 'each image must be a data:image/… or https:// URL';
    req.images = b.images as string[];
  }
  if (b.schema !== undefined && b.schema !== null) {
    const s = b.schema as Record<string, unknown>;
    if (typeof s?.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(s.name) || typeof s.schema !== 'object' || s.schema === null) return 'schema must be { name, schema }';
    req.schema = { name: s.name, schema: s.schema as Record<string, unknown> };
  }
  if (b.tools !== undefined) {
    if (!Array.isArray(b.tools) || b.tools.length > 8) return 'tools must be a list of at most 8 function tools';
    const tools: FunctionTool[] = [];
    for (const t of b.tools as Record<string, unknown>[]) {
      if (typeof t?.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(t.name) || /^browser\.(search|open|find)$/.test(t.name)) return 'each tool needs a plain name (browser.* names are reserved)';
      if (typeof t.parameters !== 'object' || t.parameters === null) return `${t.name}: parameters must be a JSON schema object`;
      tools.push({ name: t.name, description: String(t.description ?? ''), parameters: t.parameters as Record<string, unknown>, strict: t.strict !== false });
    }
    req.tools = tools;
  }
  if (b.webSearch !== undefined) {
    if (typeof b.webSearch === 'boolean') req.webSearch = b.webSearch;
    else if (typeof b.webSearch === 'object' && b.webSearch !== null) {
      const o = b.webSearch as Record<string, unknown>;
      const ws: WebSearchOptions = {};
      if (o.contextSize !== undefined) {
        if (o.contextSize !== 'low' && o.contextSize !== 'medium' && o.contextSize !== 'high') return 'webSearch.contextSize must be low, medium or high';
        ws.contextSize = o.contextSize;
      }
      if (o.userLocation !== undefined) {
        const l = o.userLocation as Record<string, unknown>;
        if (typeof l !== 'object' || l === null) return 'webSearch.userLocation must be an object';
        ws.userLocation = {};
        for (const k of ['country', 'region', 'city', 'timezone'] as const) if (typeof l[k] === 'string') ws.userLocation[k] = (l[k] as string).slice(0, 64);
      }
      req.webSearch = ws;
    } else return 'webSearch must be true/false or an options object';
  }
  if (b.reasoning !== undefined) {
    if (!(REASONING_EFFORTS as readonly unknown[]).includes(b.reasoning)) return `reasoning must be one of ${REASONING_EFFORTS.join(', ')}`;
    req.reasoning = b.reasoning as ReasoningEffort;
  }
  if (b.maxOutputTokens !== undefined) {
    if (typeof b.maxOutputTokens !== 'number' || !Number.isFinite(b.maxOutputTokens) || b.maxOutputTokens < 16 || b.maxOutputTokens > MAX_OUTPUT_TOKENS) return `maxOutputTokens must be 16–${MAX_OUTPUT_TOKENS}`;
    req.maxOutputTokens = b.maxOutputTokens;
  }
  if (b.previousResponseId !== undefined && b.previousResponseId !== null) {
    if (typeof b.previousResponseId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(b.previousResponseId)) return 'previousResponseId must be a response id';
    req.previousResponseId = b.previousResponseId;
  }
  if (b.toolOutputs !== undefined) {
    if (!Array.isArray(b.toolOutputs) || b.toolOutputs.length > 8) return 'toolOutputs must be a list of at most 8';
    req.toolOutputs = (b.toolOutputs as Record<string, unknown>[]).map((t) => ({ callId: String(t?.callId ?? ''), output: String(t?.output ?? '').slice(0, 20_000) }));
    if (req.toolOutputs.some((t) => !t.callId)) return 'each tool output needs its callId';
  }
  if (b.store !== undefined) {
    if (typeof b.store !== 'boolean') return 'store must be true or false';
    req.store = b.store;
  }
  if (b.model !== undefined) {
    if (!(WONDER_MODELS as readonly unknown[]).includes(b.model)) return `model must be one of ${WONDER_MODELS.join(', ')}`;
    req.model = b.model as WonderModel;
  }
  return req;
}
