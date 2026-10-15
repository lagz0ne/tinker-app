# Start scaffold

Omit `.ts`, `.tsx`, and `.mts` endings in imports and exports.

These rules travel with the copied starter.
Follow the parent repo's rules too, when present.

## Authoring rule

Choose one of these four forms before adding app work.

- **Tag:** fixed settings or a fact injected by the entry.
  A unit depends on its own typed settings tags.
  There is no `env` tag; the scope maker fills each tag.
  Any outside effect (env, clock, network, console)
  enters at a seam; unit bodies stay static.
- **Data:** changing records, drafts, and visible progress.
  Use a `kind` union when states carry different values.
- **Resource:** a shared client, current user, or owned queue.
  A unit body, and every helper it calls, gets an outside library
  only from a lazy module dep.
  Declare one resource per import path in `src/demo/backend/modules.ts`.
  Take Drizzle helpers from `drizzleOrm` in `~/components/database/index.server`.
  Import tables, schemas, and own code at the top.
  Release what it owns through `ctx.defer`.
- **Operation:** an action, including reads, writes, sends, and retries.
  Declare its input and dependencies; let Core infer its context.

Feature entry points are declared units, not service factories or helpers.
An action must run through an operation to get observation and cancellation.
Outgoing HTTP uses httpRequest.controller; never call fetch from app code.
The http resource owns requests and wraps built-in fetch through httpBackend.
App code cannot reference http or httpBackend; use only httpRequest.
Tests bind the tag through `~/components/http`.
The plain check bans app imports of the named HTTP clients and raw sockets.
Telemetry uses it directly to avoid tracing its own sends.
A resource may retain native handles and private work state.
Keep saved records and visible state in data.
Do not hide a feature action behind an unobserved resource method.

Tests resolve a resource or run an operation through a small scope.
They do not boot Start to test feature work.
Never pass a scope, session, or context bag to a helper.
Only entry files create scopes and choose their stop signals.
The fixed middleware bridge stays bound to its scope and fails when unbound.

## Code outside the four forms

No classes.
Plain functions are rare; read the strict rule in tinker-forms.
Keep each one pure, with at most three plain value params and two distinct callers.
Its TSDoc names each param's source and need.
List it in `PLAIN.md`; one caller means inline it.
No helper takes a Core handle, controller, ctx, clock, signal, or IO object.
React components and native callbacks keep only their caller's contract.
Their helpers still follow the strict rule.

A service must never exist outside the graph of primitives.
Resources own long-lived clients, connections, clocks, timers, and queues.
Every file directly under `cmds/` may create and own roots.
Scope tests own their roots too.
The entry owns each root and its stop signal.
No helper module keeps a scope singleton or exports a scope getter.
Outside an entry, no module-level let or const holds a live handle,
stop controller, or native client.
Src and components never call createScope.
Module calls are restricted to the declaration list in tinker-forms.
Only a factory's returned public methods get its owned-method exception.
Hidden object methods and arrow properties follow the plain rule.
React props cannot carry Core handles or signals; components cannot await.
The plain-function cap is 17; raising it needs a decision.

The copied base entries live in `tinker/base/`.
The package `@tinker/start` holds only build tools, doctor, and the host.
Keep feature units in app files.

## The app server entry

[cmds/server.ts](cmds/server.ts) owns the server roots.
The app names it in `vite.config.ts`:

```ts
tinker({ serverEntry: "cmds/server.ts", routerEntry: "cmds/router.ts", startEntry: "cmds/start.ts" });
```

The app's tsconfig includes `cmds` and `tinker`.
`@/*` names src; `~/*` names the committed tinker folder.
Components have component.json and public indexes.
Components never import src or cmds.
Imports of another component need a direct requires entry.
Src imports components only through their public indexes.
There is no default server entry.
Prepare and doctor name a missing entry and show starter code.
They never write an entry for the app.

Importing the server command starts nothing. Its body has imports and one default async main.
The prod host calls main once before listening. The dev host starts on its first fetch.
The host calls `main({ env, signal, stdout, stderr })` once. The streams need only
`write(chunk: string): unknown`. The command reads no process globals and loads no env file.
It binds each value inline, for example `env.SMTP_FROM !== undefined && mail.mailFrom(env.SMTP_FROM)`.
Main returns `{ fetch, closed }`. Aborting the host signal closes app, then telemetry.
The one `closed` promise reports app failure first, then the first teardown error.
A start error closes what started, writes cleanup errors to stderr, and rethrows the start error.
The Node host loads .env and stops accepting requests on SIGINT or SIGTERM.
The dev host owns startup sharing, retry after failure, and abort on HMR replacement.
The dev host shares one startup promise and clears it on failure so the next request can retry.
It lists extensions and settings by hand, in the user's order.
It imports each component's public index.
There are no generated wiring files or role files.
Import createScope from @tinker/core.
Main has no let, once helper, or close callback. A local ended checks close results.
`server-entry.ts` renders over the supplied app handle.
`panics.server.ts` reports process failures without wrapping the handle.
`router-entry.tsx` loads the route tree and binds native views; the browser command owns both roots.
`cmds/start.ts` lists CSRF, requests, then app middleware. The base caches its native Start options.
The command binds the renderObservation tag from `base/observe.ts`.
Each server render reads that tag from its request root.
Only the command retains roots and stop controllers. No close helper borrows a scope.
Helpers keep only repeated code; the main keeps startup steps.
Commands sit directly under cmds; nested command files fail the checks.
Src and components never import tinker/base or cmds.
The requests component owns backendStop and the request middleware.
Copied base code owns only entry, close, panic, and observation glue.
Commands import only ~/base, ~/components, @/, and @tinker/core.
Bind one tag per app slot. Never re-export app wiring from a command.
The app writes the close order itself: app, then telemetry.
A start or close error is rethrown after both roots end.

The server adapter receives `requestContext`.
Start borrows the context. The command binds the render observer tag.
An optional `fetch(request, next)` can wrap requests.
The dev host closes on HMR replacement. The prod host closes on process shutdown.

The default server main is the only server cmd exception.
The cmd seam keeps Duke's inline env !== undefined && tag(...) list in plain view; it stays untested glue on purpose.
The browser main lives in `cmds/router.ts#getRouter`, an approved named cmd exception.
It binds router options, extensions, and each sync reader tag.
No app code may import a command file.
Commands may import app code and component public entries.

## App skills

Read the skill for the work you are doing:

- [tinker-forms](.agents/skills/tinker-forms/SKILL.md):
  before adding app code; choose its owner.
- [tinker-seams](.agents/skills/tinker-seams/SKILL.md):
  when changing imports or wiring; never edit the base.
- [tinker-feature](.agents/skills/tinker-feature/SKILL.md):
  when adding a feature; follow todos from table to page.
- [tinker-sync](.agents/skills/tinker-sync/SKILL.md):
  when saving or sharing state; use events and execution waits.
- [tinker-testing](.agents/skills/tinker-testing/SKILL.md):
  when adding or fixing behavior; test through small scopes.

Run the build before the type check and tests.
Run the shipped checks before review:

```bash
npm run build
npm run typecheck
vp test
node scripts/check-plain.mjs
node scripts/check-plain.mjs --prove
npm run doctor
node scripts/check-schema.mjs
```

Run the repo's lint and strict style census when present.
Config enters through typed tags; local services use `compose.yml`.
Only cmds/server.ts reads app inputs and fills typed tags.
Tests bind typed tags directly, without env objects.

## TanStack setup

Start already ships these skills with its installed packages.
Load the React entry guide, then only the guide for the code you touch.
Run these commands from this app folder.

<!-- intent-skills:start -->

## TanStack skills

React entry and setup:

```bash
vp dlx -- @tanstack/intent@0.5.0 load \
  @tanstack/react-start#react-start
```

Request lifetime, context, and middleware:

```bash
vp dlx -- @tanstack/intent@0.5.0 load \
  @tanstack/start-client-core#start-core/middleware
```

Server actions:

```bash
vp dlx -- @tanstack/intent@0.5.0 load \
  @tanstack/start-client-core#start-core/server-functions
```

Auth route and other HTTP routes:

```bash
vp dlx -- @tanstack/intent@0.5.0 load \
  @tanstack/start-client-core#start-core/server-routes
```

Use `vp dlx -- @tanstack/intent@0.5.0 list` to find other installed guides.
The app's `intent.skills` list selects Start and Router packages.
The guides stay in their packages and update with those packages.
<!-- intent-skills:end -->
