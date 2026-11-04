# Muse Wonder: a direct line, with the same rules

Added 11/4 23:40 KST. Muse Wonder (`muse-wonder-1.0`, preview) is reachable from three places, all through the one request builder in `adapters/wonder.ts`: the command line, the server (`POST /api/ws/:id/wonder`) and the engine (`CloserService.askWonder`). The model id is a parameter, because the docs say Spark and Wonder "take the same requests on the same endpoints".

## What the docs say (dev.meta.ai, read 2026-11-04 KST evening)

- Model: `muse-wonder-1.0`, "Muse Wonder is in preview", Standard mode only on the Model API (pay-as-you-go), 1,048,576-token context. Inputs: text, image, video, audio, PDF; output: text. Features: tool calling, structured output, search grounding, computer use, reasoning effort `minimal` … `max`.
- Pricing: $4.00 per 1M input tokens, $20.00 per 1M output tokens, $0.20 per 1M cached input; web search grounding $2.50 per 1,000 queries on top. Rate limits 3,000 requests and 4,000,000 tokens per minute per team. (Spark 1.3: $1.25 / $4.25.)
- Availability: "Muse Wonder and Muse Wonder Full aren't currently available in South Korea, on Model API or in Muse Code." Whether a key issued to a team in Korea gets a 401/403/404 for this model is not something this repository can know until the owner tries; every path here falls back to `muse-spark-1.3` by flag.
- Search grounding: `tools: [{ "type": "web_search" }]` (optional `search_context_size`, `user_location`), `include: ["web_search_call.results"]` for the considered sources; the answer's `output_text` blocks carry `url_citation` annotations (url, title, offsets). Function tools in the same request must not be named `browser.search`, `browser.open` or `browser.find`.
- Tool calling: flat function tools (`type`, `name`, `description`, `parameters`, `strict`), `parallel_tool_calls` (one call per turn when false), `tool_choice` only `auto`; results go back as `function_call_output` items with `previous_response_id`.

## Command line

```
node scripts/wonder.ts --prompt "List what to check before selling a beige wool coat on KREAM"      # dry run, prints the request, sends nothing
npm run wonder -- --prompt "…"                                                                       # live, key from the Keychain (scripts/with-key.sh)
npm run wonder -- --prompt "Where is a beige wool coat listed for resale in Korea right now?" --search --country KR
npm run wonder -- --prompt "Describe the garments in this photo" --image ./outfit.jpg --effort low
npm run wonder -- --prompt "…" --schema ./schema.json          # {"name":"wonder_answer","schema":{…}} → strict JSON, parsed
npm run wonder -- --prompt "…" --store                         # keep the response so --previous <id> can continue it
npm run wonder -- --prompt "…" --model muse-spark-1.3          # same request on Spark
```

The dry run prints the body with images redacted. A live run prints the answer, citations, function calls, usage and cost, and appends one line to `.data/wonder_calls.jsonl` (status, timing, usage, cost, search count, response id; never the key, the prompt or the answer). `--out file.json` keeps the full result.

## Server and engine

- `POST /api/ws/:id/wonder` with the same fields as the CLI (`prompt`, `instructions`, `images` as data: or https: URLs, `schema`, `tools`, `webSearch`, `reasoning`, `maxOutputTokens`, `previousResponseId`, `toolOutputs`, `store`, `model`). The owner's wardrobe only in real mode; public sample closets get `SCOPE_DENIED`. The response carries `result`, `callLines`, `liveChips`, `mode` and `links` (below).
- `CloserService.askWonder(ws, { request, sessionId })` runs the same gate as the photo loop (kill switch, app total, session and visitor-day caps at `WONDER_EST_MICRO_USD` ≈ $0.05 per call) and writes one call row per HTTP attempt with `operationId: null`. Nothing is written to the wardrobe ledger; the `stateHash` does not move.
- Mock mode never pretends: the canned reply reads "MOCK · Muse Wonder was not called. This is a canned line from mock mode." Tests script their own replies (`MockScript.wonder`).

## On screen: "Find listings with Wonder"

The keep-or-let-go panel on My closet (`/closet?decide=J2`) carries one button on its sell side. It sends one search-grounded request for the piece on the chosen platform (Korean platforms add `user_location: KR`) and shows only the links that came back, sorted by platform, with a "cited" chip on the sources the answer used. The model's text is never shown on a live call, so no price enters the screen from the model; in mock mode the canned line is shown as is. Changing the platform clears the box. The call goes through `POST /api/ws/:id/wonder`, so the caps, the kill switch and the call ledger apply, and a public sample closet in real mode gets a refusal chip instead of a call.

## Links, not prices

`engine/links.ts` sorts the urls a search-grounded answer cited or considered by resale platform (KREAM, Karrot, Bunjang, Poshmark, eBay, Grailed, Depop, Vinted, or the host for anything else), https only, cited sources first. A link is a place for the owner to look. No price is read from a page or from the model's text: the owner opens the link, reads the price there, and enters it as evidence themselves, with the platform's own currency and the date. That keeps the price cards and the keep-or-let-go screen on counted, owner-entered rows.

## Cost and limits in this build

- Prompt at most 4,000 characters, at most 4 images (6 MB each on the CLI), output at most 8,000 tokens, at most 8 function tools, at most 8 tool outputs per follow-up.
- Every attempt is a call row: the ledger, the admin screen and `/version` count it like any other model call.
- Tests: `tests/wonder.test.ts` W-01 … W-08 (request shape, reader, cost, holds, mock, service gate, JSON validation, links). No test reaches the network.

## Status

Written from the documentation; live calls 0 as of this commit. The first live call is the owner's (`npm run wonder -- --prompt "…"`); if the model answers 401/403/404 from Korea, the same command with `--model muse-spark-1.3` is the fallback, and the README keeps saying which one actually ran.
