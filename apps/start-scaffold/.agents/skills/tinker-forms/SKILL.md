---
name: tinker-forms
description: Choose the owner of new app code.
---

# Choose a form

Read this before adding app code.
Choose one form for each piece of work:

- Tag: fixed settings passed in by the entry.
  See `databaseSettings` in `src/backend/database.ts`.
- Data: changing records, drafts, and visible progress.
  See `profile` and `nameDraft` in `src/frontend/state.ts`.
- Resource: a client or work owned by the app or session.
  See `database` and `auth` in `src/backend/`.
- Operation: an action, including a read, write, or send.
  See `changeTodo` in `src/backend/todos.ts`.

Load a native library inside its resource factory.
Release owned clients with `ctx.defer`.
Use `ctx.signal`, `ctx.clock`, and `ctx.random`.
Use a `kind` union when states hold different values.

Code outside these forms needs a TSDoc reason beside it.
Say why none of the four forms can own that work.
React views render data and invoke operations through hooks.
Readers validate raw input once at the door.
Never pass a scope or context bag to a helper.

## Plain functions are rare

Follow ADR 0099 and ADR 0100.
Start strict; loosen only through a new decision.
No classes.
A plain function must meet every rule:

- Pure: no IO, await, time, random, signal, or held state.
- Plain value params only.
  No Core handle, controller, ctx, clock, signal, IO object, or callback.
  No any or unconstrained type param.
  Option bags carrying a signal fail too, including library types.
  Unknown is allowed for door readers and error guards.
  Never cast a plain value to a forbidden type inside a plain body.
- At most three params, each the smallest value needed.
- At least two distinct callers in src; tests do not count.
  Direct calls and typed callback registrations count.
  Repeated calls by one caller count once.
  Self-calls, imports, re-exports, and value uses do not count.
  One caller means inline it.
- TSDoc names where each param comes from and why it is needed.
  Use `@param value - From the form; why: read its name.`
- Each kept function appears in `PLAIN.md`.
  The script's `PLAIN_MAX` is 17.
  Raising that cap needs a new decision.
  Regenerating the list cannot raise the cap.

Object methods and arrow properties follow every plain rule too.
Being somewhere inside a unit call gives no exception.
Only the members of a resource factory's returned object are owned methods.
This includes its arrow body or a local object returned by that factory.
Object.assign may add native methods to that returned value.
A hidden object inside a method is still plain work.
Return only the public methods callers need.
Never expose a send method that bypasses flush dedupe.

Core callbacks are direct run, factory, input, and hooks members of a unit's options object.
Wrapping a factory callback in Object.freeze gives no exception.
Only the resource unit's direct factory grants owned public methods.
Process entries are top-level start and close in src/server.ts,
plus its module-level entry object's fetch method.
The router entry is a top-level getRouter in its listed entry files.
Names alone grant no entry exception.
The returned public native methods of these entries keep their entry contract.
An extension hook may return its public value, just as a resource factory does.
Other inline callbacks are allowed only in a callback slot whose callee is outside src, or a JSX attribute.
A native options object may supply that native callee's named callbacks.
A named event or lifetime callback must be registered with its native owner.
Named callbacks in native lifetime slots on a resource's public value keep that owner's contract.
Inline callbacks passed to a resource method follow the plain rule.
Pass the native send function and its data record to sync.execute.
Object.freeze, value coercion, fallback expressions, and a local helper call give no exception.
A native callback's IO still needs a resource, operation, or hook body to own it.

A schema used once stays a schema.
Put JSON parsing in the operation's input callback.
A throw inside a schema transform can escape its standard validator.
The input callback lets Core return a managed input failure.

A React component has a capital name, a JSX body, and at most one props param.
Its props cannot hold Core handles, ctx, clock, signals, scope, or controllers.
Props callbacks are allowed.
No await in its own body; render data and use hooks.
Its nested helpers still follow the plain rule.

Plain bodies also reject Date, performance.now, crypto, console, global fetch,
and local or session storage.
Review still checks hidden library effects and each param's size.

The old queue exposed a private clock helper:

```ts
async runTimer(flush: () => Promise<void>) {
  await ctx.clock.sleep(1000, stopTimer.signal);
  await flush();
},
```

The final public start method owns its timer promise instead:

```ts
start(flush: () => Promise<void>) {
  if (settings.side !== "ssr")
    timer = Promise.resolve().then(async () => {
      while (!stopTimer.signal.aborted) {
        try {
          await ctx.clock.sleep(1000, stopTimer.signal);
        } catch (error) {
          if (!stopTimer.signal.aborted) throw error;
          return;
        }
        if (!stopTimer.signal.aborted) await flush();
      }
    });
},
```

This is the shipped method in `src/scaffold/telemetry/queue.ts`.
It may take a callback because its resource owns the timer promise,
stops the signal, and awaits that promise during close.
A plain function has no such owner, so it may not take a callback.
The queue returns only ingest, start, flush, and close.

## Services stay in the graph

A service must never exist outside the graph of primitives.
A resource owns each long-lived server, client, connection, clock, timer,
watcher, queue, and cache.
An operation may own short-lived work for its call.
A plain function never starts or retains a service.
Only code inside a factory, run, or hook body has graph ownership.
The root entry may create only its root stop controllers outside that graph.
The tabLifetime resource owns the pagehide listener and removes it on close.
An option value evaluated at import has none.

Only these files may reference Core createScope:

- `src/server.ts`: inside start, which owns both roots and stop signals.
- `src/router.tsx`: inside getRouter, the client entry.
- `src/scaffold/frontend/router.tsx`: inside getRouter, its fixed implementation.

Imports alone are allowed.
Aliases, parentheses, casts, arrays, call, and Reflect.apply give no exception.
No module-level root creation, even in an entry file.
No helper exports a scope, a scope getter, or a start function.
Exported accessors and arrow properties returning a scope fail too.

Outside entries, no module-level let or const may hold a live Core handle,
AbortController, or native client, including nested and promised values.
Declared Core units are allowed; resolved live handles are not.
Only the server entry's entry.owned lazy promise may retain its root context.
Importing it starts no clients.
The fixed backend entry declares only the setup extension.

At module scope, calls and new expressions fail unless they declare app setup.
The allowed calls are:

- Core tag, data, resource, operation, and extension declarations.
- Zod builders: string, number, boolean, unknown, email, url, uuid, object,
  strictObject, literal, enum, array, record, union, discriminatedUnion, and instanceof.
  Their min, max, int, positive, nonnegative, regex, trim, optional, nullable,
  strict, loose, default, or, refine, and extend declaration steps.
  Parse and safeParse run only inside owned work or a plain reader.
- Drizzle table, column, and index declarations.
- createIsomorphicFn, createServerFn, createMiddleware, createFileRoute,
  createRootRouteWithContext, createStartHandler, createStart, and cva.
- Their server, client, middleware, inputValidator, and handler declaration steps.
- Object.assign joining a declared Core unit with metadata.
- Only in src/client.tsx: React's startTransition and hydrateRoot for the native entry.

Everything else needs an owner before it runs.
The responseBodies resource tracks open native readers.
Its deferred close cancels any reader the consumer left open.

## Check

Run `npm run check:plain -- --prove` after changing this rule.
Every planted failure must exit 1 by its rule name.
Run `npm run check:plain` before review.
Use `npm run check:plain -- --list` to inspect the list.
Review every entry before copying that output into `PLAIN.md`.
The list and code must agree; the cap still applies to list output.
The check reads src and skips .gen, .generated, and declaration files.
It follows symbols, imports, aliases, and library signal properties.
