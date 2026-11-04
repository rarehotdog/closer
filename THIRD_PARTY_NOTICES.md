# Third-party notices

Runtime dependencies: two. Everything else uses only the Node.js standard library
(`node:http`, `node:sqlite`, `node:crypto`, `node:zlib`, `node:test`).

| Package | Use | License |
|---|---|---|
| @meta-sam/parser 0.1.0 (Meta) | Official SAM 3.1 client library: box-prompt text (`buildObjectPrompt`, `engine/coords.ts`), response parsing (`parseResponsesStream`, `adapters/sam.ts`) and mask decoding (`decodeMaskToRaster`, `adapters/sam.ts`, `adapters/samDecoder.ts`) | SAM License (see `node_modules/@meta-sam/parser/LICENSE`; it ships with the package and must accompany any redistribution) |
| three 0.170.0 (three.js authors) | Browser 3D for the closet view (`web/public/closet3d.js`). The server serves `node_modules/three/build/three.module.min.js`; the file is not copied into this repository | MIT (see `node_modules/three/LICENSE`; the license header stays in the served file) |

Development tools used locally, not vendored and not shipped:

| Tool | Use | License |
|---|---|---|
| Node.js (>= 22.18) | runtime, built-in TypeScript type stripping, `node:sqlite`, `node:test` | MIT |
| TypeScript (`tsc`) | optional type check (`npm run typecheck`) | Apache-2.0 |
| Playwright (Chromium) | screenshots in `docs/screens/` (`npm run screens`) | Apache-2.0 |

No code was copied from other repositories.
