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

Start strict; loosen only through a new decision.
No classes.
A plain function must meet every rule:

- Pure: no IO, await, time, random, signal, or held state.
- Plain value params only.
  No Core handle, controller, ctx, clock, signal, IO object, or callback.
- At most three params, each the smallest value needed.
- At least two call sites in src; tests do not count.
  A callback passed to its caller counts as a site.
  One caller means inline it at that caller.
- TSDoc names where each param comes from and why it is needed.
  Use `@param value - From the form; why: read its name.`
- Each kept function appears in `PLAIN.md`.
  Keep the list small; it should only shrink.

A schema used once stays a schema.
Pass it as the operation input instead of adding a parse helper.
Put JSON parsing in the operation's input callback.
A throw inside a schema transform can escape its standard validator.
The input callback lets Core return a managed input failure.
Named helpers inside a factory follow the same rule.
Methods owned by a resource keep its private work.
Core run, factory, input, and hook callbacks meet Core's contract.
Native framework and event callbacks meet their caller's contract.
A named callback gets this rule only when handed to that caller.
Returning a callback is allowed only from its resource or entry.
These are callbacks, not a place for free service factories.

A React component has a capital name, a JSX body, and at most one props param.
Only render work and hook calls belong there.
Its nested helpers still follow the plain rule.
The only root factories are Start's server entry and client router factory.
Their private close callbacks own their root's end.
This exception does not cover any helper module.

The queue used to take a clock and controller outside the graph:

```ts
const owned = new TelemetryQueue(settings, ctx.clock, health);
```

Now the resource's method reads its own clock in place:

```ts
async runTimer(flush: () => Promise<void>) {
  while (!stopTimer.signal.aborted) {
    try {
      await ctx.clock.sleep(1000, stopTimer.signal);
    } catch (error) {
      if (!stopTimer.signal.aborted) throw error;
      return;
    }
    if (!stopTimer.signal.aborted) await flush();
  }
},
```

This is the shipped method in `src/scaffold/telemetry/queue.ts`.
Its resource owns the queue, stop signals, and pending promises.
There is no class or helper with clock params.

## Services stay in the graph

A service must never exist outside the graph of primitives.
A resource owns each long-lived server, client, connection, clock, timer,
watcher, queue, and cache.
An operation may own short-lived work for its call.
A module declares units; it never starts clients or stores a live handle.
A plain function never starts or retains a service.

Only these files call `createScope`:

- `src/server.ts`: the process entry owns both roots and stop signals.
- `src/router.tsx`: the client router entry.
- `src/scaffold/frontend/router.tsx`: its fixed implementation.

No helper exports a scope getter or returns a scope.
No module-level let holds a scope or handle.
The server entry keeps its lazy start promise in its entry object.
It owns creation and close there; importing it starts no clients.
The fixed backend entry file declares only the setup extension.

## Check

Run `npm run check:plain -- --prove` after changing this rule.
Each planted failure must fail by its rule name.
Run `npm run check:plain` before review.
Use `npm run check:plain -- --list` to inspect the list.
Copy that output into `PLAIN.md` only after reviewing every entry.
The check reads src and skips `.gen`, `.generated`, and declaration files.
It follows imported names and type aliases.
It checks params, docs, sites, classes, roots, and known service creation.
Review still checks purity and each param's size.
