# Closer

Closer keeps the piece you want to wear, changes only what feels off or what changed, using clothes you already own, and counts only the wears you confirm.

- Live URL: not deployed yet.
- Watch the recorded run: `/w/demo-rc1` (read-only, same state hash as the recorded run). Not recorded yet.
- Built Oct 27–Nov 4 ET.

| Built during the hackathon | Third-party | Pre-existing |
|---|---|---|
| All code and docs in this repository. The first commit is the scaffold only. | No runtime dependencies. Dev tools are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). | 0 |

License: [MIT](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)

## Verify it yourself

1. Open `/w/demo-rc1` and `/version` in a private window and compare the stateHash and sha.
2. Compare `git rev-parse HEAD` of the code you have with the sha on `/version`: they must be the same release.
3. Turn K1 on in `/admin` and check that a button re-plan still works while model calls are off.

## Current state

This build runs in **mock mode**: no Meta model is called and no key exists anywhere in the repository. The Meta adapters are written from the documentation examples and are unverified until the key window. Status, test results and next steps: [docs/status.md](docs/status.md) · [docs/at_results.md](docs/at_results.md).

| Command | What it does |
|---|---|
| `npm test` | Runs the keyless acceptance tests, unit tests and static checks; writes `docs/at_results.json` and `docs/at_results.md`. |
| `npm run ui` | Starts the local server on http://localhost:8787 (mock mode). Screens: `/` Try, `/app`, `/w/demo-rc1`, `/admin`, `/version`. |
| `npm run screens` | Captures the screens into `docs/screens/` with Playwright Chromium (Playwright is not a project dependency). |
| `npm run typecheck` | Optional `tsc` check (needs TypeScript and Node type definitions installed locally). |

Requires Node.js 22.18 or newer (built-in TypeScript type stripping and `node:sqlite`).

## How it works

1. One outfit photo and one sentence go to `muse-spark-1.3` (Spark 1): garment boxes, the piece to keep, the direction, and the pieces that feel off.
2. Code turns the boxes into pixel box prompts with its own object IDs; `sam-3.1` returns one mask per ID. Code re-measures each garment's color from the mask pixels and asks only about a garment whose color disagrees.
3. Nothing is saved until the owner confirms the cards.
4. Code builds the candidate list per slot (owned, available, owner rules, pinned item kept, only flagged slots open). A second `muse-spark-1.3` call (Spark 2) picks at most two edits through one function-tool turn; code re-checks every item, slot and rule.
5. A selection or a wear is shown as saved only after a fresh read from the server matches the screen.
6. A laundry, repair or storage button re-plans only that slot, with zero model calls.

Measurement table: `Photos: {n} ({real or AI-generated}), ground truth written before any call` — not measured yet.

## FAQ

- **How is this different from a closet catalog?** It edits only the pieces that feel off in the outfit you photographed to decide, the decision photo is also how items get registered, and a selection or wear counts only after it is read back.
- **Does it buy anything or contact shops?** No. Next: a read-only check a shopping client could call before checkout. Not built.
- **What does the model decide, and what does code decide?** Models read the photo and sentence, draw masks, and choose among candidates code passed. Code issues IDs, enforces every rule and state transition, and writes to the ledger.
