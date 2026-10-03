---
name: tinker-seams
description: Keep feature work outside the fixed scaffold.
---

# Keep the seams

Use this when changing imports or app wiring.
Never edit `src/scaffold/` to add a feature.
It is fixed source updated through the registry.

App code may import fixed scaffold exports.
It must never edit them.
Examples used by the app:

- `eventHistory`: `src/scaffold/backend/events.ts`.
- `syncClient`: `src/scaffold/frontend/sync.ts`.
- `startRequests`: `src/scaffold/start.ts`.
- `readResult`: `src/scaffold/backend/result.server.ts`.
- `responseBodies`: `src/scaffold/backend/body.server.ts`.

The seam check guards only imports from scaffold to app.
The scaffold reads your values through:

```ts
import { records } from "@/lib/tinker";
import { database } from "@/lib/tinker.server";
```

Fill the open `Register` in `src/lib/tinker.ts`.
It supplies change, result, public, and private bodies.
See `src/contracts/sync.ts` for the current bodies.
Put raw-input readers in `src/contracts/`.

Server imports belong in server functions and routes.
Never import `tinker.server` into a browser view.
Keep fixed sync tables in the scaffold's schema.
Your feature tables belong in `src/backend/`.

After changing wiring:

```bash
npm run build
npm run typecheck
npm run check:plain
npm run test:seam
npm run test:boundary
npm run test:schema
```
