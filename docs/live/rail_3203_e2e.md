# Rail Studio: live upload and account verification

Verified on 2026-11-06 against `http://localhost:3203/?view=vault`.
The integration belongs to `rarehotdog/closer`, branch `codex/rail-ledger-meta`.
This is a separate branch; it has not been merged into the submitted `main`.
The port-3201 design checkout and its running process were preserved.

## Corrections

- Footwear cards can be selected and displayed after either the initial scan or
  an additional tile scan. Existing deselections remain intact.
- `hoodie` now exists in both the frontend fixture mapping and the server's
  actual outfit/closet model schemas. Previously, the server vocabulary could
  not accept a hoodie even though the canonical ledger could.
- Both upload dialogs provide a direct account entry. Signed-in users browsing
  samples receive the appropriate personal-wardrobe guidance. Pending photos
  are cleared on identity changes and are never silently imported.

## Executed checks

An isolated QA account uploaded the repository's design-kit photograph
`apps/rail-studio/src/assets/images/front_heavy_hoodie_1793835551654.jpg` through
the actual file input. This was a test photograph, not a customer's garment.

| Boundary | Observed result |
| --- | --- |
| Real photo analysis | `muse-spark-1.3` HTTP 200, 11,896 ms; `sam-3.1` HTTP 200, 2,267 ms for the saved scan |
| Classification and cutout | `hoodie`, canonical `top`, SAM mask |
| Confirmation and display | Confirm & Hang produced the photograph on the 3D Walk-Around rail |
| Photo integrity | Both saved image fields exactly match the actual response cutout; the server receipt is retained |
| Entered price | KRW 125,000 asking-price test record, visible in the tag, inspector and canonical ledger; no automatic market-price claim |
| Decision | One explicit Keep decision; unconfirmed fees still produce unknown net proceeds |
| Persistence | Reload, sign-out/sign-in, server restart and a fresh browser restore the exact saved document and canonical state hash |
| Account isolation | A second QA account has zero personal pieces and zero model-call records from the first account |
| Existing data | The pre-existing wardrobe snapshot hash is unchanged |
| Responsive detail | Desktop 1440 × 1000 and mobile viewport 390 × 844; price/detail visible, no horizontal overflow on mobile |
| Browser runtime | No uncaught page errors in the completed checks |

Presentation revision: **3**. Canonical ledger revision: **4**.

Saved canonical state SHA-256:
`50e6ffe8a01827d647e5799fc564a4b621df88d8624ead52c477f1866dc7de58`

Saved image data-URL SHA-256:
`6f0de663a5c5eaa48de3df2fb1482b0b2da097cf8f92194b948ddf9fbf8d143b`

## Verification coverage and limits

App tests: **155 passed**. Root tests: **174 passed, 9 skipped**. Both TypeScript
checks, the production build, static AT-17/AT-18 checks and the diff check passed.
Regression tests exercise all canonical types against both real request schemas
and validators, hoodie passage through both pipelines, footwear selection and
receipt preservation. The focused review found no remaining P0–P2 issues.

Four live scans were made while diagnosing and completing the check: the first
exposed the missing hoodie vocabulary, one browser run was interrupted, one
verification selector failed after analysis, and the final scan was hung and
saved. All eight provider requests returned HTTP 200. Subsequent persistence
checks reused that saved item without additional model calls. The recorded
local cost estimate is 29,405 micro-USD ($0.029405), not a provider invoice.

The initial checks used Aside; repeated closure of the verification tab required
an isolated Chromium browser for the completed sequence. The price-input and
auth-tab verification selectors were corrected; these were harness failures,
not failed account saves. Screenshots and sanitized readback evidence were
captured locally. Keys, passwords, session values, database files and photo
payloads are excluded from the repository.

This verifies one clear hoodie photograph and the account persistence path.
It does not establish accuracy on a crowded real closet, physical phone-camera
behavior, or live footwear segmentation. Those types and multi-card selection
have automated contract coverage. Mobile evidence is a browser viewport check.
