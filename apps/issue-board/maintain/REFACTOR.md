# Command and write refactor

Review this with slice 7. The base is 45ee4351d9766d46e1eb087e7c453a324aab3de2.
Core is unchanged. Start changes are allowed for this refactor.

All three commands use the typed identity defineMain from tinker/base/main.ts.
The host passes env, args, signal, stdout, stderr, and exit. Only a command
calls exit. The first stop code wins, including a later signal or throw.
A later error is logged. The host aborts the signal, joins closed, flushes the
streams, then sets process.exitCode. It never calls process.exit. The default
10-second grace deadline uses SIGKILL only if cleanup has not finished.

Codes: 0 success, 1 unexpected error, 64 bad args, 65 bad CSV data, 78 bad
startup config, 130 SIGINT, 143 SIGTERM. Server results still need fetch.
The worker treats the host signal as a soft stop so the current SMTP result
can commit. Its root closes after the pass finishes.

## Write entry points

Paths below start at apps/issue-board.

| Entry                                     | Child session call                       |
| ----------------------------------------- | ---------------------------------------- |
| Issue server function                     | src/transport/issues.functions.ts:29     |
| Comment server function                   | src/transport/comments.functions.ts:15   |
| Team server function                      | src/transport/teams.functions.ts:15      |
| CLI import runner, once per 100-row batch | src/transport/import-runner.server.ts:21 |
| Worker pass, once per claimed batch       | src/backend/outbox.server.ts:175         |

The server function calls already supplied signal. That opens a child of the
request session and waits for its defers. The request session at
`tinker/components/requests/start.ts:27` still owns the streamed response
lifetime. It does not own the write transaction.

The CLI and worker dispatch now use settle with a real signal. Their write
operations and steps never create a session or commit. Each step resolves the
same session-target database.transaction. Its factory checks out one client,
waits until its first query to start BEGIN, and defers COMMIT on success or
ROLLBACK on failure/cancel/release, then releases the client.
COMMIT errors escape as TeardownFailed. The dispatch returns only after close.
Idle sessions send no transaction SQL. Optional commit/rollback ends are safe
to repeat; a later query raises typed TransactionEnded. No integration commits
or rolls back. No TransactionNotCommitted or afterCommit hook is added.

The installed Core ownerOf returns the resolving layer for target session.
The owner test resolves a probe in the request parent and gets a second probe
in the write child. The child closes before dispatch returns; the parent stays
open. Empty tags do not create a child. The test supplies a signal.

Reads keep database. Digest enqueue is still one atomic SQL statement on that
handle; it needs no multi-step transaction. Delivery uses transaction.

## Steps and rules

issues.change calls team.lock, issues.save, issues.delta, alerts.queue, and
streams.fanOut. team.lock calls execution.seen. Comments call comments.save
between the same shared lock, alerts, and fan-out steps. Teams use
teams.authorizeJoin, teams.save, teams.publish, execution.seen, and streams.fanOut.
Imports use import.target, team.lock, import.assignees when needed, and then
import.saveRow, alerts.queue, and streams.fanOut for each changed row.
Every step runs through a controller and has its own span.

team-write.server.ts holds the shared member lock and re-check, team row lock,
execution lookup, outbox INSERT SELECT, and event append rules. All use the
ambient transaction. Stream order, version guards, actor-only receipts,
peer-only alerts, and replay guards stay in place. Team joins retain their
own two-stream protocol and check admin rights before looking up an email.

## Checks

The unit tests cover deferred COMMIT failure, exactly one rollback on throw
or mid-step cancel, no second end after explicit commit, no BEGIN for reads,
TransactionEnded after either end, and child session ownership. The real server proof holds COMMIT with a
deferred PostgreSQL trigger and checks zero HTTP bytes before release. A
second COMMIT fails with 23514; the client gets an RPC error, never accepted.
A real CLI run proves a bad second batch leaves only the first 100 rows.

proof-transaction-controls.mjs builds two broken scratch modules at the real
module ID. Hiding a COMMIT error must fail the client-error check. Omitting
await on COMMIT must fail the zero-response-bytes check. The source and good
build are restored. Four more scratch faults prove rollback SQL counts, lazy
BEGIN, single end, and typed query rejection can each fail. The inherited live proofs and their scratch faults also
run serially. Host tests cover startup exit, repeated exit, exit then SIGTERM,
late throw, output flush, grace timeout, and dev socket close after cleanup.

## Files to upstream

Outside src and cmds, the runtime and host changes are:

- tinker/components/errors/errors.ts: add the typed TransactionEnded error.
- tinker/components/database/component.json: declare that error dependency.
- tinker/base/main.ts: MainContext, defineMain, startup code mapping, close check.
- tinker/base/panics.server.ts: report the error to the command; no process exit.
- tinker/base/server-entry.ts: stopped server response for a refused startup.
- tinker/components/database/database.server.ts: client checkout and session transaction.
- tinker/components/database/types.ts: lease and transaction types.
- tinker/components/database/index.server.ts: public transaction export.
- ../../packages/start/lib/main-host.mjs: shared lifetime and dev close join.
- ../../packages/start/lib/dev-server.mjs: env, args, exit, HMR close join.
- ../../packages/start/bin/tinker.mjs: serve uses the shared host.
- ../../packages/start/vite.mjs: connect dev server close to the app host.
- ../../packages/start/package.json: export main-host.
- ../../packages/start/tests/main-host.test.mjs: host lifetime tests.
- ../../packages/start/tests/parts.test.mjs: allow the new host export.
- package.json and ../../pnpm-lock.yaml: use local workspace Start tooling.
- scripts/check-plain.mjs: recognize only the real defineMain callback in direct
  command defaults, plus the named base helpers. It also recognizes a returned
  Object.assign held in a local variable and callback options on a resource
  method. No arbitrary helper is treated as a resource method. The cap stays 17.

App-only support changes outside src and cmds are the serial test dispatch and
presets, affected feature tests, transaction tests, PLAIN.md, IMPORT.md, MAIL.md,
and the maintain hosts, demo, proof scripts, scratch transforms, CPU profile capture and SVG rendering,
and trace capture. The final report lists every changed path with diff counts.
The existing vendor archive stays unchanged. No registry or Core file changes.

## Streamed page audit

No issue, comment, team, or import write runs in a page loader or render.
The page loaders call bootstrap/account reads and getTeamMembers. Components
send writes only from event handlers through the POST server functions above.
The CLI and worker run outside rendering. Mail enqueue stays inside the write
transaction; there is no afterCommit hook.

Bootstrap does initialize and lock sync cursor rows. That work is already in
an awaited native database.transaction inside bootstrapPublic/bootstrapPrivate
(src/demo/backend/sync.server.ts:23 and :39), reached through the child call
in tinker/components/sync/functions.ts:16. Its commit finishes before the
snapshot returns. The streamed request session owns no pending transaction.

The starter counter, todo, and profile POST functions also settle with signal
(src/transport/counter.functions.ts:15, todos.functions.ts:23,
profile.functions.ts:22 and :30). Those older operations still await their
native transactions before returning. The profile's existing background
notification remains as shipped and commits its result separately; it is
never started by a page render. Auth GET/POST dispatch at
src/routes/api.auth.$.ts:14 and :18 also awaits its child call before returning
its response. No write needed to move out of a page render.

## Exact call shape and driver guard

Today's Core has owned settle/run calls and session(options, fn). The owned
settle call below opens the child because it carries signal. It waits for
that child's defers before returning. It is already the server function shape:

```ts
return readReceipt(
  await context.session.settle(changeIssue, {
    input: data,
    signal: context.signal,
  }),
);
```

The import runner uses batch.settle({ rawInput: { rows }, signal }) and reports
the batch after it returns. The worker pass uses deliver.settle({ signal })
and reports sent rows after it returns. Steps have neither session nor end code.
The request parent stays open until its response body ends.

The database adapter uses the public pg query call to await lazy BEGIN. It
uses Drizzle's public logger callback to reject an ended query before Drizzle
wraps driver errors. That keeps TransactionEnded as the error's own kind.
Both callbacks belong to the session resource; no app step gets a raw client.
The shared pool remains the read handle. The lease client is released only
after the session end finishes. A failed BEGIN is followed by rollback; a
failed COMMIT also attempts rollback before the client is released.

## CPU profiles

Duke's 09:10 wrap-up direction assumes performance is the same. Profile work
has stopped. Keep the files already saved; do not collect more profiles.

Duke's 08:38 change replaces request timing comparisons with CPU flamegraphs.
No request latency claim is made. The capture uses node --cpu-prof with a
100-microsecond sampling interval. Move and comment each make 1,000 serial
POST calls. Import runs the same 201-row demo file once. Each case gets its
own process. Startup and shutdown stay in the profile. SVG width leaves out
idle and program samples; garbage collection stays visible.

The capture checks accepted replies and the saved row count or issue version.
The fixture reset clears sync events as well as their streams. The six raw
profiles and self-contained SVGs live in
/home/paseo/plans/issue-board-refactor-flame/. The final report lists the top
five self frames and the new transaction and step frames. This uses no new
dependency. Hover a chart frame to see its source and sampled source lines.

The old profiles show the extra issue/team reads in move, comment, and import.
Those reads now use the saved row from RETURNING and the already locked team
key. Their source-line sample evidence is saved beside the charts. The guard,
lock order, version test, outbox rows, and event writes stay the same.

The old demo timing driver now keeps its 12 drag/drop and no-reload checks
without clocks, artificial delays, a DOM observer, or a bench queue job.
The full Lightpanda demo still checks all three page error lists are empty.
