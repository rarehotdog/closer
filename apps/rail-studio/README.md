# Closer · Rail Studio

Rail Studio is the English boutique interface inside the submitted
[rarehotdog/closer](https://github.com/rarehotdog/closer) repository. Its starting
point is the port-3200 `closerdesign` `meta-live-v2` interface
(`7dec1d08409befd162651800b8815222a9ac4b01`). The current scene ports the port-3201
spatial design from `closerdesign` main
(`96989fe1f6fbc73c049a2553d32d048d2d8627a8`): walnut and brass hangers, an oak-floor
Walk-In Vault, side bays and camera navigation. This directory is a
post-submission addition and runs as a separate app from the root interface.

One outfit or closet photo becomes pieces you can inspect and act on. The face
is a 3D boutique rail; the records, their sources and the next decision remain
visible in the inspector. Account storage uses the root project's account store,
canonical event ledger and price/decision engine in this app's account database.

## What it does

- **Photo → cards → rail.** `Upload Photo & Hang` (or `?scan=1`) sends a JPEG to
  this app's server. The pipeline calls `muse-spark-1.3` for garment boxes and
  `sam-3.1` for masks, validates the answers, measures colour from mask pixels
  and returns cut-out cards for confirmation. Closet mode reads up to 16
  garments and can scan the remainder in overlapping parts. A confirmed real
  piece saves to its signed-in account with a server-issued scan receipt. Live
  analysis requires sign-in; guests can explore samples or add a manual photo.
- **Spatial browsing.** Front Rail, 3D Walk-Around, Left Wing, Right Wing and
  Overhead are real camera positions. Drag can sweep the rail or orbit the room;
  wheel zoom and WASD navigation are available in the room. Auto orbit moves
  back and forth within the room, rather than claiming a full 360-degree spin.
  Selecting a piece pauses orbit and opens its inspector. Camera controls sit
  above the measured bottom dock and follow its collapsed state.
- **Visible prices.** Hang tags show recorded prices or an explicit unknown
  state. The desktop Market Pulse card shows the latest entered or sample
  observation, its platform, asking/traded status and date. Its change amount
  compares records of the same currency, platform, kind and sample status.
  It is not an automatic market-price feed.
- **Organized inspection.** Clicking a piece or Market Pulse opens the same
  inspector: Overview, market price history, purchase information, counted wear
  and price records, fees and the Keep / Prepare to sell / Decide later action.
  The layout includes section navigation and a mobile bottom sheet.
- **Accounts and saving.** Account registration, sign-in, sign-out and account
  wardrobes are available from this surface. Save state distinguishes loading,
  saving, verified saved, errors and another-tab conflicts. Local personal
  pieces can be imported explicitly after sign-in. The Account panel and Asset
  Ledger show canonical saved activity, recorded prices and model requests.
- **Review and fallback.** Review compares Sell and Undecided pieces and sums
  eligible net proceeds separately by currency. Grid provides the same records
  when WebGL cannot run or reduced motion requests a static first view. The
  loading skeleton and retry path avoid leaving a blank 3D stage.

## Record boundaries

Sample prices and pieces remain labelled and excluded from owner totals.
Unknown prices and wear history remain unknown; no invented probability or
engagement score is added. Currencies are not combined or converted. Net proceeds
require the relevant costs to be confirmed. The Meta key remains server-side;
the test transport is labelled `Test fake · no Meta call`.

Guests use browser-local storage (`closer.scannedPieces.v1`). Creating or signing
into an account does not silently claim that guest collection. The explicit
import accepts personal scan/custom pieces and excludes built-in demo IDs,
sample pieces, fake scans and sample observations. Signed-in private wardrobes
are not copied into guest localStorage. Sample-view edits do not save into the
account, and switching identities clears the displayed account scene.

`server/accountRouter.ts` reuses root `store/extras.ts` and `web/guard.ts` for
accounts and sessions. `AccountWardrobeStore` uses root `SqliteLedger` and
`FeatureService`: registration/removal/update events, the presentation snapshot,
price evidence and immutable decisions commit in one SQLite transaction on one
connection. A failed projection rolls back the whole save. Successful saves are
read back; request IDs make an uncertain retry idempotent, while both the
presentation and canonical revisions prevent stale edits from overwriting data.

Existing account snapshots migrate on authenticated read. Photos, presentation
revision and original update time are preserved; no sample pieces are seeded.
Dated wear history is never invented from a reported aggregate. Removing a piece
with canonical wear or outfit references is refused to preserve that history.
Otherwise an explicit removal event remains after the current item is removed.
A new explicit Keep/Sell save creates a new decision with its own cost snapshot;
subsequent cost edits do not rewrite previous decisions. Legacy decisions without
cost snapshots retain unknown net proceeds.

Root platform/currency rules remain explicit. For example, Vinted USD is preserved
in the presentation document but excluded from canonical totals because the root
engine's Vinted contract uses EUR. The app reports partial projection and the
reason; it does not convert money or silently count it as another currency.

This uses the submitted project's **actual ledger implementation**, with an
account-scoped `GET /api/account/ledger` report. It does not share another running
app's database or cookies, merge existing port-8789 accounts, or expose its admin
API. Those existing data stores remain independent.

## Run

Use Node.js **22.18 or newer**, including its `node:sqlite` support. Install both
sets of dependencies because this app imports root account modules.

```sh
# From the repository root:
npm ci
cd apps/rail-studio
npm ci
PORT=3203 CLOSER_KILL=1 npm run dev
```

Choose an unused port; existing 3200/3201 development servers need not be
restarted. Run these commands from `apps/rail-studio`:

```sh
npm run lint           # TypeScript checks
npm test               # scan, routes, records, accounts and wardrobe controller
npm run build          # dist/ and bundled server.js
PORT=3203 npm start    # production; defaults to port 3000 without PORT
```

Keep `src/assets/` alongside `dist/` and `server.js`: the server serves the
bundled garment photographs. `CLOSER_KILL=1` disables model calls without
disabling local account or wardrobe work.

### Account configuration

| Variable | Behavior |
| --- | --- |
| `CLOSER_ACCOUNT_DB` | SQLite path. Default `../../.data/rail-studio.sqlite`, resolved from the process working directory: when launched here, repository-root `.data/rail-studio.sqlite`. Use an absolute path for an isolated test or deployment database. |
| `CLOSER_ACCOUNT_COOKIE` | Defaults to `closer_rail_acct`, separate from the root app's cookie. Give concurrent Rail Studio instances distinct names if they must have separate sessions on the same host. |
| `CLOSER_APP_ORIGIN` | Optional comma-separated exact allowed origins, including scheme and port. Without it, the request's own origin is used. Account mutations require a matching Origin and JSON; sibling-port and cross-site writes are rejected. |
| `CLOSER_ACCOUNT_COOKIE_SECURE` | Set to `1` for HTTPS deployment, particularly behind TLS termination. Cookies also use Secure when Express recognizes an HTTPS request; they are HttpOnly and SameSite=Strict. Do not enable Secure for plain-HTTP localhost testing. |

The default database contains this surface's canonical ledger and is separate
from any already-running root app's database. Do not
point a test server at an existing personal database. Database files and their
SQLite sidecars are denied by the application's private-file guards; keep the
database out of public asset directories and deployment artifacts.

### Model configuration

The local `dev` and `start` commands load the repository-root `.env` if it
exists. Put `MODEL_API_KEY` there (file permissions `600`), or supply it through
the process environment. Existing environment values take precedence. AI Studio
can still inject `MODEL_API_KEY` through Settings → Secrets. Never use a `VITE_`
prefix or commit a key. From the root, `npm run rail:live` uses the existing
`scripts/with-key.sh` launcher without printing its secret.

`GET /api/scan/status` reports `live` when a key is configured, `fake` only with
`CLOSER_SCAN_FAKE=1` and no key, `no_key` without either, or `off` with
`CLOSER_KILL=1`. Configuration alone does not prove a successful model call.
Recorded successful calls, reservations and estimates are separate status fields.

Live `POST /api/scan` requires the current account, matching `workspaceId` and
same-origin request. Each real HTTP attempt has a durable reservation and call
record, including failures. The `CLOSER_SCAN_BUDGET_USD` cap (default 2, maximum
50) applies across restarts of this account database. Costs use local estimates,
not provider invoices; a processed response can exceed its pre-call estimate.
Uncertain requests retain their allocation. Each request times out after at most
45 seconds, within a 90-second scan deadline. The process also limits scan rate.

The server binds each returned garment to its account, original card, cutout
pixels and mask/crop source. Confirmed choices retain the server's type and
formality and the owner's allowed color selection in the canonical ledger.
A rejected SAM mask is explicitly shown as a box crop; HTTP 200 alone does not
mean a usable mask. A legacy record without a receipt is labelled unverified.
Signed-in sample-photo previews do not make paid calls or enter private records.

For an end-to-end live check, use the UI to sign in, choose a personal or synthetic
test image, scan, confirm, then inspect **Saved ledger & photo analysis history**.
The older `npm run live:scan` script is a standalone adapter diagnostic: it does
not exercise account authentication, the HTTP budget or canonical persistence.
Do not use its output as evidence that those boundaries passed.

## Verification scope

Tests, type checks and a production build are separate from browser and provider
verification. The account tests use isolated databases; the scan tests can use
a labelled fake without calling Meta. Neither proves a successful live model
request. Live Meta scanning must be checked with a configured key and a real end-to-end
run; record model HTTP statuses and mask/crop validation separately.

For browser review, check desktop and phone widths, Walk-Around → Front Rail,
selection during orbit, camera-bar spacing with the dock open and closed,
inspector navigation, Market Pulse sources, grid fallback, and account
save/reload/sign-out/switch/conflict behavior. Account inputs must not trigger
WASD navigation. The optional smoke script requires separately installed
Playwright and Chromium:

```sh
BASE=http://localhost:3203 node scripts/browser_check.cjs
```

It writes screenshots under `.data/shots`; they are not committed. A verification
report should state the actual route, viewport and result from that run rather
than treating an old screenshot or build as current UI evidence.

## Code map

- `server.ts` — Express, scan routes, account routes and private-file guards.
- `server/scan.ts`, `server/closetSpark.ts`, `server/closer/` — photo pipeline,
  adapters and validation; `server/fakeMeta.ts` is the test transport.
- `server/accountRouter.ts`, `accountStore.ts`, `wardrobeSchema.ts` — account
  boundary, revisioned persistence and incoming-record validation.
- `server/ledgerBridge.ts` — canonical item, price and immutable decision mapping.
- `server/scanJournal.ts` — durable call reservations, receipts and provenance.
- `src/components/CanonicalLedgerPanel.tsx` — account-scoped canonical readback.
- `src/utils/accountWardrobe.ts`, `src/hooks/useAccountWardrobe.ts` — guest and
  account state, explicit imports, save queue and conflict handling.
- `src/App.tsx` — rail/grid, dock, account surface, scan flow and selection.
- `src/components/BoutiqueRail3D.tsx`, `MarketPulse.tsx`,
  `GarmentInspectDrawer.tsx` — spatial scene, recorded-price card and inspection.
- `src/utils/ledgerLogic.ts`, `tagForms.ts`, `review.ts` — counts, currency-safe
  totals, truthful tags and review calculations.

Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
(`@meta-sam/parser` under the SAM License).
