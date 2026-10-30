# Third-party notices

Runtime dependencies: none. The server, engine, ledger and tests use only the
Node.js standard library (`node:http`, `node:sqlite`, `node:crypto`, `node:test`).

Development tools used locally, not vendored and not shipped:

| Tool | Use | License |
|---|---|---|
| Node.js (>= 22.18) | runtime, built-in TypeScript type stripping, `node:sqlite`, `node:test` | MIT |
| TypeScript (`tsc`) | optional type check (`npm run typecheck`) | Apache-2.0 |
| Playwright (Chromium) | screenshots in `docs/screens/` (`npm run screens`) | Apache-2.0 |

No code was copied from other repositories.
