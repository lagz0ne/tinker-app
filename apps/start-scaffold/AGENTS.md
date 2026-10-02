# Start scaffold

These rules travel with the copied starter.
Follow the parent repo's rules too, when present.

## Authoring rule

Choose one of these four forms before adding app work.

- **Tag:** fixed settings or a fact injected by the entry.
- **Data:** changing records, drafts, and visible progress.
  Use a `kind` union when states carry different values.
- **Resource:** a shared client, current user, or owned queue.
  Load the native library inside its factory.
  Release what it owns through `ctx.defer`.
- **Operation:** an action, including reads, writes, sends, and retries.
  Declare its input and dependencies; let Core infer its context.

Feature entry points are declared units, not service factories or helpers.
An action must run through an operation to get observation and cancellation.
A resource may retain native handles and private work state.
Keep saved records and visible state in data.
Do not hide a feature action behind an unobserved resource method.

Tests resolve a resource or run an operation through a small scope.
They do not boot Start to test feature work.
Never pass a scope, session, or context bag to a helper.
Only entry files create scopes and choose their stop signals.
The fixed middleware bridge stays bound to its scope and fails when unbound.

## Code outside the four forms

A different form needs a reason why none of the four can own the work.
Put that reason in TSDoc beside the declaration.
Shorter code or a familiar service class is not a reason.
Do not add a helper that runs or wires a feature graph.

Framework entries and adapters meet the native framework's contract.
React components render data and invoke operations with React hooks.
Input readers validate raw values at the operation or network door.
Error declarations, database schemas, and wire encoders describe values.
They must stay free of app effects and mutable app state.

Review every other form against the four choices before keeping it.
Keep fixed setup under `src/scaffold/` and feature units in userland.

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
