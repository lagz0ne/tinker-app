# Start authoring

Follow the parent repo's rules too. The [current contract](https://github.com/lagz0ne/tinker-app/blob/next/docs/decisions/start-decompose.md) owns the
full API, import, input, update, and helper rules. These five rules are its
local checklist; each release's changes stay in UPGRADE.md.

1. **Own the boundary.** Hosts own process inputs, sockets, OS stops, and output
   flush. Direct cmds files bind app inputs and own roots; scope tests own theirs.
   Keep wiring inline and test command input, startup, exit, and close.
2. **Keep imports one-way.** Base owns native entry/close/panic/observation glue.
   Components use public entries and direct requires, never base, app, or cmds.
   App code uses component public entries. Start ships tools and hosts.
3. **Declare work and owner.** Use tags, data, resources, and operations for their
   named jobs. Native bridges and extension hooks keep their owned contracts.
   No authored classes or live module clients. Pure helpers have at most three
   plain value inputs, at least two real callers, TSDoc, and a PLAIN.md entry.
   The cap stays **17**. Owned resource methods and native callbacks are not
   permission to pass a context bag through a plain helper.
4. **Bind only real seams.** Bind host config inline and validate startup values
   before ready. Bind request inputs per call. App readers, cross-root values,
   and native/test IO can use tags. Import mandatory component work directly.
   Not every required tag is startup config; defaults must support useful work.
5. **Close before success.** Use defineMain and the clean exit contract. Close
   app before telemetry and join the call before reply bytes or progress output.
   Board writes and the migrated counter/todos use the session transaction. New
   multi-step writes follow that pattern. Page reads write no tables; the browser
   renews sessions through explicit auth POST. Old profile writes keep their
   awaited native transactions until their listed migration. Board and auth mail
   use the durable outbox; auth's pool adapter needs a separate committed enqueue.
   Profile keeps its stored notification flow.

Keep imports at the top in the formatter's groups and use blank lines between
steps. Read the shared contract for named native boundaries, request bindings,
auth hooks, SQL/send bounds, and helper checks. Tests bind typed values directly.

## App skills

Read the skill for the work you are doing:

- [tinker-forms](.agents/skills/tinker-forms/SKILL.md):
  before adding app code; choose its owner.
- [tinker-seams](.agents/skills/tinker-seams/SKILL.md):
  when changing imports, copied owners, or wiring.
- [tinker-feature](.agents/skills/tinker-feature/SKILL.md):
  when adding a feature; follow todos from table to page.
- [tinker-sync](.agents/skills/tinker-sync/SKILL.md):
  when saving or sharing state; use events and execution waits.
- [tinker-testing](.agents/skills/tinker-testing/SKILL.md):
  when adding or fixing behavior; test through small scopes.

Run the build before the type check and tests.
Run the shipped checks before review:

```bash
npm run gate:commands
npm run typecheck
vp test
npm run test:proofs
node scripts/check-plain.mjs
node scripts/check-plain.mjs --prove
npm run doctor
node scripts/check-schema.mjs
```

Run the repo's lint and strict style census when present.
Config enters through typed tags; local services use `compose.yml`.
Direct cmds/* entry files read host inputs and fill typed tags.
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
