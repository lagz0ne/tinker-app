---
name: operation
description: >
  Use when you add or change an action in a
  Tinker app: its label, input shape, deps, run
  body, how to call it, or how it fails. Also
  when a check prints tinker/plain,
  tinker/floating or tinker/graph, or for a
  Workflow SDK flow.
metadata:
  purpose: >
    How to write, call and fail an operation,
    and why a plain helper function is not
    allowed in app code.
  type: sub-skill
  library: '@tinkered/core'
  library_version: '0.31.14'
requires:
  - core
sources:
  - 'lagz0ne/tinkered:packages/core/src/main.ts'
---

# Operation

An operation is an action: a label, an input
shape, its deps and a `run`. Each call is a span.

## Setup

```ts
import { createScope, data, operation } from "@tinkered/core";
import { z } from "zod";

const hues = data<number[]>({
  label: "wave.hues",
  initial: [],
});

const press = operation({
  label: "wave.press",
  input: z.object({ x: z.number(), y: z.number() }),
  depends: { hues: hues.controller },
  run: ({ hues }, { input, clock, random }) => {
    const hue = Math.floor(random.next() * 360);
    const at = clock.currentTimeMillis();
    hues.update((list) => [...list, hue]);
    return { hue, at, x: input.x };
  },
});

const scope = createScope();
const { hue } = await scope.run(press, {
  input: { x: 1, y: 2 },
});
```

- `label` is the span's name. Write it as a plain
  string, one per operation.
- `input` checks the raw input at the door. Bad
  input fails with `DataValidationFailed`.
- Take time from `clock` and chance from
  `random`. A test swaps both.

## Core patterns

### Call an operation from an operation

Name it in `depends`. Then call it.

```ts
import { operation } from "@tinkered/core";
import { z } from "zod";

const double = operation({
  label: "math.double",
  input: z.number(),
  run: (_, { input }) => input * 2,
});

const quad = operation({
  label: "math.quad",
  input: z.number(),
  depends: { double },
  run: ({ double }, { input }) => {
    const twice = double.run({ input });
    return double.run({ input: twice });
  },
});
```

A dep that is an operation has `run` and
`settle`, as a scope has.

### Read the result without a throw

```ts
import { createScope, operation } from "@tinkered/core";

const risky = operation({
  label: "risky",
  run: () => 1,
});

const scope = createScope();
const result = await scope.settle(risky);
if (result.status === "success") result.value;
if (result.status === "failed") result.error;
if (result.status === "cancelled") result.reason;
```

- `run` answers the value or throws.
- `settle` answers one of three: `success`,
  `failed` or `cancelled`.

### A durable flow: the Workflow SDK

The [Workflow SDK](https://workflow-sdk.dev) finds
a workflow and a step by a directive, so they are
plain functions. Put them in a flow file: a name
that ends in `.flow.server.ts` (or `.flow.ts`).
There, `tinker/plain` lets them pass (ADR 0148).

```ts no-check
// src/naming/naming.flow.server.ts
export async function nameFlow(idea: string) {
  "use workflow";
  return await suggest(idea);
}

async function suggest(idea: string) {
  "use step";
  return callOperation("naming.suggest", { idea });
}
```

- Keep a flow function thin: it awaits hooks,
  sleeps, and calls operations by name.
- The logic stays in operations. A step cannot
  import a cell: the SDK bundles it on its own.
- A step can run again after a crash. Make each
  step safe to repeat.
- The directive is first in the body. A helper
  beside it in the file still fails.

## Common mistakes

### HIGH: a plain helper function [tinker/plain]

A helper has no span and no deps. A trace cannot
show it, and a tool cannot draw it.

Wrong:

```ts no-check
function nextHue(seed: number) {
  return Math.floor(seed * 360);
}
```

Right: make it an operation and name it in
`depends`, as `double` above.

Check: `tinker check` prints the file and
the line of each plain function.

### HIGH: a helper behind a callback [tinker/plain]

A function passes the check when Core, a library
or React calls it. When your code calls it by
name, it is a helper again.

Wrong:

```ts no-check
const add = useCallback(
  (a: number, b: number) => a + b,
  [],
);
add(1, 2);
```

Right: make `add` an operation. Or keep a
closure: a function that reads a name of the
function around it, such as a counter of its
resource.

Check: `tinker check` prints the helper
and the line that calls it.

### HIGH: `name` in place of `label`

```ts expect-error
import { operation } from "@tinkered/core";

const bad = operation({
  name: "wave.press",
  run: () => 1,
});
```

### HIGH: a call that nobody awaits [tinker/floating]

A scope answers each call with a promise. A call
with no `await` loses its error.

Wrong:

```ts no-check
scope.run(press, { input: { x: 1, y: 2 } });
```

Right: `await scope.run(...)`, or keep the
promise and await it later.

### HIGH: the code graph differs from tinker.graph [tinker/graph]

`tinker.graph` holds one line per operation: its
exits, and the cells and operations its `run`
reads, writes and calls. The lines are facts.
`tinker check` builds them from the code. Each
line that differs from the file is a finding.

The finding never judges the change. You judge
it.

An empty set means "none". A `?` means the graph
could not see: a dep handed on (passed to a
function, put in an array, given another name),
the deps handed on whole, a call it does not
know, a dep it cannot name (a capsule or contract
member, a label not written as a string, an
`atScope` controller), a tag that holds a unit,
or a `run` passed by name. A tag that holds a
union of unit kinds, or a held cell that `run`
never uses, may show no `?`.

The graph reads each op's own body. A resource's
own code is not read: a write inside a
resource's value does not show.

Wrong: a move now writes a cell it did not, and
nobody read that.

```ts no-check
list.set({ ...now, state: input.state });
audit.set({ id: input.id, by: me });
```

```text
issue.move.do: writes{issues.audit.set,
  issues.list.set}, tinker.graph says
  writes{issues.list.set}
```

Right: read the change. If you meant it, run
`tinker graph --write` and commit the file. The
reviewer reads its diff. If you did not mean it,
fix the code.

### HIGH: one check written in two operations

`tinker.graph` shows each place that reads a
cell. Read it before you write a check, and
again in the diff after `tinker graph --write`.

- Before: find the lines that read the cell your
  check needs. If an operation already makes
  that check, call it.
- After: a cell in `reads{}` on a new line, for
  the same check, is a copy. Move the check into
  one operation, and call it from each.

Wrong: each change reads the lock itself.

```text
doc.edit.do reads{docs.locked.of, ...
doc.share.do reads{docs.locked.of, ...
doc.delete.do reads{docs.locked.of, ...
```

Right: one operation reads it. The others call
that operation.

```text
docs.canEdit reads{docs.locked.of}
doc.edit.do calls{docs.canEdit}
doc.share.do calls{docs.canEdit}
doc.delete.do calls{docs.canEdit}
```

The rule then changes in one place. A copy that
a later change misses is a bug.

When a rule changes, the graph lists each
operation that reads its cell or calls its
check. Change each one.

### MEDIUM: `Date.now()` or `Math.random()` in a run

The run then gives a new answer in each test. Use
`clock` and `random` from the run's second
argument.

## Completion

- `tinker check` prints `tinker check: OK`.
- The lint prints no `no-floating-promises`.
- A test calls the operation through a scope.
  Read [testing](../testing/SKILL.md).
