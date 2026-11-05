# Photo scan server (meta-live branch)

The AI Studio app gets one server route that turns a photo into garment cards with Meta's models.

```
browser  --(JPEG <= 1600 px + PNG copy + optional sentence)-->  POST /api/scan  (server.ts)
server   --> muse-spark-1.3: one box per garment, kept piece, direction, pieces that feel off
         --> code check (closer engine/validate.ts)
         --> sam-3.1: one mask per box (prompt built with Meta's @meta-sam/parser)
         --> code check: ids, frame size, mask inside its box (tolerance max(8 px, 5 %))
         --> colour measured from the mask pixels; cut-out PNG per garment
browser  <-- cards; the owner confirms; the pieces hang on the rail
```

- The key is read on the server only (`MODEL_API_KEY`, or `META_API_KEY`), set in AI Studio
  Settings -> Secrets. It is never sent to the browser, logged or returned.
- Modes (`GET /api/scan/status`): `live` with a key; `fake` only with `CLOSER_SCAN_FAKE=1` and no
  key (a local stand-in, labelled "Test fake · no Meta call" on screen); `no_key`; `off` with
  `CLOSER_KILL=1`.
- Guards: 20 scans per address per 10 minutes; a spend cap per process
  (`CLOSER_SCAN_BUDGET_USD`, default 2) checked on each scan's estimate before any call.
- When SAM fails, every card falls back to Spark's box crop. When only some masks are refused by
  the code check, each mask is checked on its own: the ones that pass are used, the refused ones
  fall back to a box crop with no measured colour, and the note under the cards names each refusal.
  (Closer's own server holds the whole photo instead.)
- Nothing is stored on the server. Confirmed pieces start with no price, no wear record, no fee
  and no decision.

Modes of one scan (`mode` in the request body):
- `outfit` (default): one worn outfit + an optional sentence; Spark also names the piece to keep, the
  direction and the pieces that feel off (one garment per slot, as in closer).
- `closet`: a closet, a rail or clothes laid out; Spark lists up to 16 garments with its own schema
  (`server/closetSpark.ts`), no one-per-slot rule, and says when the photo shows more than it listed.

In the browser (`src/components/ScanPhotoModal.tsx`, opened with `?scan=1`): the outfit / closet toggle,
"try a sample photo" (a design-kit studio shot, or the four shots side by side as a rail; pieces from
it are marked Sample), confirmed pieces kept in this browser's localStorage and a Remove button on
each scanned piece. The sample closet itself is never stored.

Checking a key: `MODEL_API_KEY=... npm run live:scan -- [photo.jpg photo.png] [outfit|closet]` makes
one real scan and prints statuses, timings, counts and code-check notes only (never the key, the
prompt or model text); the summary also goes to `.data/live_scan_check.json`, which is not committed.

Tests (`npm test`): `server/scan.test.ts` (pipeline with the test fake: masks, colour questions, SAM
failure and refusal fallbacks, closet mode, input checks), `server/routes.test.ts` (over HTTP: no key,
the key never in a response, kill switch, fake labels, 400/413 as JSON, rate limit) and the ledger tests.

`server/closer/` is a copy of the photo pipeline from github.com/rarehotdog/closer at dba9ff3
(adapters, engine checks, colour, PNG and cut-out code); `engine/validate.ts`, `adapters/types.ts`
and `shared/ledger.ts` are trimmed to the Spark 1 and SAM parts.

Run: `npm run dev` (Express + Vite on port 3000), `npm run build && npm start` (production),
`npm test` (scan tests with the test fake + the ledger tests), `npm run lint` (type check).
