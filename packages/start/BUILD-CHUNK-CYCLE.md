# start/build-chunk-cycle

Branch: `start/build-chunk-cycle`.
Owner: writer (Codex).
Status: Review.
Next: lead review.
Base: `scaffold/proof-app-imports` at `e84ee76c`.
Fetched and rebased onto `origin/main` at `196b43c2`.

## Plain choice

Keep the forced body chunk with its static deps.
Set `includeDependenciesRecursively: true`.
The body now sees `startServer` after it is set.
Core stays external.

The test builds Start's real request entry in memory.
TanStack and Drizzle stay external in that test.
It checks the emitted chunks' import lists for mutual imports.
This costs less setup than a running server and one request.
The full scaffold check covers the running server too.

## Proof

The same new test ran in a separate `origin/main` worktree.
It failed with the body and request chunks importing each other:

```text
start.js -> assets/tinker-start-C_V2CI_h.js
assets/tinker-start-C_V2CI_h.js -> start.js
Tests 1 failed | 2 passed (3)
EXIT 1
```

On this branch:

```text
Tests 3 passed (3)
EXIT 0
```

The writer gate ran as one chain:

```bash
vp run -r build && vp check \
  && vp run @tinker/start#test \
  && vp run @tinker-start-scaffold#test
```

```text
Build: EXIT 0
Found 0 errors and 27 warnings in 671 files
Start: 43 files, 450 tests passed
Scaffold: 6 files, 31 tests passed
EXIT 0
```

The untouched `origin/main` check also had 27 warnings.
`vp run @tinker-start-scaffold#check` exited 0.
Its middleware, serve, registry, and compose checks all passed.
The real browser proof passed auth, mail, sync, and profile saves.
`pnpm validate` ran after the gate, with no build or tests beside it.
All 19 lanes passed; exit 0.

## Chunk limit

Both built apps have no pair of chunks that import each other.
The small app has 13 server chunks; the scaffold has 47.
Start-owned chunks have at most 100 top-level bindings.
Their highest context slot is 29, below 255.
The body chunk has 3 bindings in the small app and 4 in the scaffold.

The small app's mixed TanStack entry has 876 bindings and slot 738.
Both numbers match the separate `origin/main` build.
The server lane excludes TanStack's large chunk from its owned-chunk limit.
`pnpm validate` checks Core and React slots; Start's built chunks were checked separately.

## Jev

The changed build test has 0 of 3 entries flagged.
The package test run has 0 of 200 entries flagged.
Its old private-import and helper notes are outside this patch.
The promise run has 0 of 198 missing README promises.
It has 40 unsure matches.

The required `main..HEAD` scan reads inherited Core changes:
local `main` is older than the fetched base.
It reads no file changed by this ticket.
Those Core notes stay with the Core tickets and their existing labels.
A second scan of `origin/main..HEAD` has no source files and no flags.
The scanner reads TypeScript; this patch changes only `.mjs` code.
No new label lines; no edit to `tools/jev/cases.jsonl`.
This keeps the requested package scope.

## Scope and report

No `src` file changed, so no mutation run was needed.
No timing run or push.
Proof stays in this package to keep the requested file scope.
Raw logs: `/home/paseo/.cache/build-chunk-cycle-proof/`.
The gate log is the trimmed output seen by the writer.
Core feedback: none.
