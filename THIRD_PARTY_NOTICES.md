# Third-party notices

Runtime dependencies: one. Everything else uses only the Node.js standard library
(`node:http`, `node:sqlite`, `node:crypto`, `node:zlib`, `node:test`).

| Package | Use | License |
|---|---|---|
| @meta-sam/parser 0.1.0 (Meta) | Official decoder for SAM 3.1 mask payloads (`decodeMaskToRaster`), used in `adapters/samDecoder.ts` | SAM License (see `node_modules/@meta-sam/parser/LICENSE`; it ships with the package and must accompany any redistribution) |

Development tools used locally, not vendored and not shipped:

| Tool | Use | License |
|---|---|---|
| Node.js (>= 22.18) | runtime, built-in TypeScript type stripping, `node:sqlite`, `node:test` | MIT |
| TypeScript (`tsc`) | optional type check (`npm run typecheck`) | Apache-2.0 |
| Playwright (Chromium) | screenshots in `docs/screens/` (`npm run screens`) | Apache-2.0 |

No code was copied from other repositories.
