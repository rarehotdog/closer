# Third-party notices

This section covers the original submitted application. The post-submission React
interface in `apps/rail-studio` is imported from
[`rarehotdog/closerdesign`](https://github.com/rarehotdog/closerdesign), commit
`7dec1d08409befd162651800b8815222a9ac4b01`, with small visual refinements.
Its dependency versions are recorded in its own lock file and its notices are in
[`apps/rail-studio/THIRD_PARTY_NOTICES.md`](apps/rail-studio/THIRD_PARTY_NOTICES.md).

Runtime dependencies: two. Everything else uses only the Node.js standard library
(`node:http`, `node:sqlite`, `node:crypto`, `node:zlib`, `node:test`).

| Package | Use | License |
|---|---|---|
| @meta-sam/parser 0.1.0 (Meta) | Official SAM 3.1 client library: box-prompt text (`buildObjectPrompt`, `engine/coords.ts`), response parsing (`parseResponsesStream`, `adapters/sam.ts`) and mask decoding (`decodeMaskToRaster`, `adapters/sam.ts`, `adapters/samDecoder.ts`) | SAM License (see `node_modules/@meta-sam/parser/LICENSE`; it ships with the package and must accompany any redistribution) |
| three 0.170.0 (three.js authors) | Browser 3D for the closet view (`web/public/closet3d.js`). The server serves `node_modules/three/build/three.module.min.js`; the file is not copied into this repository | MIT (see `node_modules/three/LICENSE`; the license header stays in the served file) |

Development tools, not vendored and not shipped (the two devDependencies are skipped by `npm ci --omit=dev` in the deploy kit and the container image):

| Tool | Use | License |
|---|---|---|
| Node.js (>= 22.18) | runtime, built-in TypeScript type stripping, `node:sqlite`, `node:test` | MIT |
| TypeScript 5.9.3 (`tsc`, devDependency) | type check (`npm run typecheck`, also in CI) | Apache-2.0 |
| @types/node 22.20.5 (devDependency) | Node.js type definitions for `tsc` | MIT |
| Playwright (Chromium) | screenshots in `docs/screens/` (`npm run screens`) | Apache-2.0 |

The original submitted application did not copy code from other repositories.
