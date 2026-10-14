# Copy Start into the app

Status: approved by Duke on 2026-10-14 at 16:24.

## Decision

The app owns Start's runtime code. `@tinker/start` keeps the Vite plugin,
the host command, and doctor. Doctor checks code from outside the app.
This replaces the runtime package rule in ADR 0106 and the package imports
in ADR 0118. The app still writes its own command wiring by hand.

The source used to build registry items lives in
`apps/start-scaffold/tinker/`. The mutation score floor there is 85.
The writer does not run mutation checks; the lander runs them.

## Import rules

- `cmds/*.ts` imports `~/base`, `~/components`, `@/`, and `@tinker/core`.
- `src` imports components and npm packages.
- `tinker/base` helps components plug into commands: entries, close,
  panic pages, and observation. It may import components.
- Components import other components through their public entries.
  They never import base, src, or commands.
- Base never wraps a component just to forward its exports or calls.
  A command shows its startup pattern in one file.

Base always needs requests and errors. Commands pass optional sync and
telemetry parts into base. Base never imports those optional components.
Config serves only builds and import isolation. No wiring is generated.

## D1: app slots

Each value sync needs from the app has its own tag, as in ADR 0105.
The command binds each tag. Sync never imports the app or its commands.
This replaces reads through `#tinker/server` and `#tinker/router`.

Auth follows the same seam rule from ADR 0113. The lead approved two
required tags: `sendAuthMail` and `sessionDeleted`. The command binds
the mail queue and the sync notice operation, one plain value per tag.
Neither tag has a default. Auth checks both at start and names a missing
binding in `cmds/server.ts`. Auth requires only errors, requests, and
database; it never imports mail or sync.

## D2: env rules

`component.json` gains `env`. Doctor reads that JSON only, as in ADR 0117.
The command reads env once and passes typed settings to each component.
Runtime settings code never imports the tooling package.

## D3: source of copied code

`apps/start-scaffold/tinker/` is the source of base and component registry
files. Registry JSON is built from those app files. Tests follow the code
they prove. Copied code is updated with `shadcn add --diff`.

## Move order and checks

First teach doctor the new rules in warn mode. Move base, errors, then
requests and health. Move every requests user together so a request has
one middleware and one session. Then move HTTP, database and auth,
telemetry, and sync. Last, remove package runtime exports and build one
registry item per component.

Each step passes `vp check`, `vp run -r test`, and the scaffold proof.
Jobs run one at a time with `VITEST_MAX_WORKERS=1` and
`VP_RUN_CONCURRENCY_LIMIT=1`. Stop after requests and health for mid review.

## Native entry exceptions

The lead approved named base entry exceptions after mid review. Only the
copied server, router, start, close, and panic entry files may have them.
Each function is named in check-plain with a reason. Src, components, and
commands have no function skip. Native callbacks keep their SDK contracts.
The plain-function cap stays 17. Planted cases check both IO and handle
patterns in src, a component, a command, and an unlisted base file. A new
function in a listed base file must still pass the plain rule.

The router command holds options as a value. Its request loader lives in
the named base router entry. Loading the route tree at request time keeps
the router and server from waiting on each other during startup.
