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
  Declare one resource per import path in `tinker/components/demo/backend/modules.ts`.
  Take Drizzle helpers from `drizzleOrm` in `@tinker/start/server`.
  Import tables, schemas, and own code at the top.
  Release what it owns through `ctx.defer`.
- **Operation:** an action, including reads, writes, sends, and retries.
  Declare its input and dependencies; let Core infer its context.

Feature entry points are declared units, not service factories or helpers.
An action must run through an operation to get observation and cancellation.
Outgoing HTTP uses httpRequest.controller; never call fetch from app code.
The http resource owns requests and wraps built-in fetch through httpBackend.
App code cannot reference http or httpBackend; use only httpRequest.
Tests bind the tag through `@tinker/start/testing`.
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
The base client entry and scope tests own their roots too.
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

The base lives in `node_modules/@tinker/start/`.
Keep feature units in app files.

## The app server entry

[cmds/server.ts](cmds/server.ts) owns the server roots.
The app names it in `vite.config.ts`:

```ts
tinker({ serverEntry: "cmds/server.ts" });
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

The entry reads env once, starts telemetry, then the app.
It lists extensions and settings by hand, in the user's order.
It imports each component's public index.
There are no generated wiring files or role files.
Import createScope from @tinker/core.
The copied tinker/base/server.ts holds the entry and close helpers.
Its close helper alone may borrow named roots and their stop controllers.
Helpers keep only repeated code; the main keeps startup steps.
Commands import only ~/, @/, @tinker/core, and their framework entry.
@tinker/start is allowed until Start is decomposed into base registry components (next card).
Fill the serverParts tag with the component exports; never re-export them from the main.
The app calls createScopeClose to close the app, then telemetry.
That helper starts nothing and shares one close promise.
A start or close error is rethrown after both roots end.

The default export has three fields:
`requestContext`, `renderObserve`, and `close`.
Start borrows the context and observer.
An optional `fetch(request, next)` can wrap requests.
The entry closes on HMR replacement and process shutdown.

The scaffold's client wiring lives in `cmds/router.ts`.
It exports router options, extensions, and the sync readers.
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
Settings come from `.env`; local services use `compose.yml`.
The server seam's `settings(env)` checks the keys
and fills each settings tag. The app entry calls it at start.

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
