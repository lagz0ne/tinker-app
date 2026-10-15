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

Base always needs requests and errors. Commands own sync and telemetry
wiring and pass native router options, observers and close callbacks.
Base never imports those optional components.
Config serves only builds and import isolation. No wiring is generated.

## D1: app slots

Each value sync needs from the app has its own tag, as in ADR 0105.
The command binds each tag. Sync never imports the app or its commands.
This replaces reads through `#tinker/server` and `#tinker/router`.

Auth follows the same seam rule from ADR 0113. The lead approved two
required tags: `sendAuthMail` and `sessionDeleted`. The command binds
the mail queue and the sync notice operation, one plain value per tag.
Neither tag has a default. Auth checks both at start and names a missing
binding in `cmds/server.ts`. Auth requires only requests and database; it never imports mail or sync.

## D2: config is tags (owner change)

Duke reversed D2 on 2026-10-15 at 07:06. A component needs typed config,
not env. component.json declares requires only. The command reads each input
inline beside its tag binding. Missing values leave required tags unbound.
Tests bind tags directly; no component takes an env object or converter.

Core checks missing tags lazily. Each component's one start extension
resolves its required tags so ready fails with MissingTag and the tag name.
Safe defaults remain only where the component can run without a choice.
A Core-level eager check is a later card; this round does not change Core.

Auth passes hooks the active run's Core Scope.ExtensionCtx. Concurrent runs
keep separate contexts. SDK callbacks outside a live run use authStartup's
start context, because no calling flow owns those background callbacks.
Owner change, 2026-10-15 16:30: main gets env and signal; it returns closed.
The lead also approved stdout and stderr as structural write streams.
The host calls `main({ env, signal, stdout, stderr })` once. The streams need only
`write(chunk: string): unknown`. The command reads no process globals and loads no env file.
It binds each value inline, for example `env.SMTP_FROM !== undefined && mail.mailFrom(env.SMTP_FROM)`.
Main returns `{ fetch, closed }`. Aborting the host signal closes app, then telemetry.
The one `closed` promise reports app failure first, then the first teardown error.
A start error closes what started, writes cleanup errors to stderr, and rethrows the start error.
The Node host loads .env and stops accepting requests on SIGINT or SIGTERM.
The dev host owns startup sharing, retry after failure, and abort on HMR replacement.

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
commands have no function skip except cmds/router.ts#getRouter, approved by the lead for the browser main. Native callbacks keep their SDK contracts.
The plain-function cap stays 17. Planted cases check both IO and handle
patterns in src, a component, a command, and an unlisted base file. A new
function in a listed base file must still pass the plain rule.

The router command opens its telemetry and app roots in plain view.
Base loads the native route tree at request time and binds fallback views,
the React provider and page-hide cleanup. No base helper takes a scope.
The Start command lists CSRF, requests and app middleware in order;
base configures the CSRF guard and caches the command's async options.
