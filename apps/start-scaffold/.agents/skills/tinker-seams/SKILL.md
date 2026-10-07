---
name: tinker-seams
description: Keep app wiring on the base's public entries.
---

# Keep the seams

Omit `.ts`, `.tsx`, and `.mts` endings in imports and exports.

Use this when changing imports or app wiring.
The base lives in `node_modules/@tinker/start/`.
Never edit it; update it with `tinker upgrade`.

App imports use only public entries:

- `@tinker/start`: startRequests and sync types.
- `@tinker/start/server`: eventHistory, readResult,
  httpRequest, env, auth settings, and sync tables.
- `@tinker/start/client`: syncClient and snapshotLoader.
- `@tinker/start/testing`: test bindings only.
- `@tinker/start/vite`: the tinker plugin.

The base reads app values through two files:

- `src/lib/tinker.ts`: extensions, records, readers,
  and the app's Register bodies.
- `src/lib/tinker.server.ts`: extensions, database,
  auth, readAccount, and bootstrap.

Doctor 5 checks these names.
Doctor 6 refuses base paths and private alias imports.
Doctor 10 reports the last build's import violations.

Fill `Register` on `@tinker/start` in the client seam.
See `src/contracts/sync.ts` for this app's bodies.
Put raw-input readers in `src/contracts/`.

Feature HTTP operations import httpRequest from
`@tinker/start/server`.
Tests bind httpBackend from `@tinker/start/testing`.
App code never uses that tag or the raw http resource.
Import feature operations directly from their files.
A server seam that re-exports a feature can form a loop.

The app owns its migrations and wake triggers.
It imports sync tables from `@tinker/start/server`.
Server imports belong in server functions and routes.
Never import the server seam into a browser view.

After changing wiring:

```bash
npm run build
npm run typecheck
node scripts/check-plain.mjs
npm run doctor
node scripts/check-schema.mjs
```
