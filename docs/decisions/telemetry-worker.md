# Server telemetry leaves the request thread

Date: 2026-10-19. Status: accepted.
Accepted: 2026-10-20 07:35 UTC.
Duke picked option B, our own worker.
Builds on: tinkered ADR 0102 (sends are not
traced), 0113 (outside effects enter at the
seam), 0119 (an extension taps the hose).

- Duke, 2026-10-19: "design first": spike both
  options, measure, then write this.
- Duke's rule: CPU flame graphs before and
  after. No median or p95 claims.
- Duke, 2026-10-20 07:35 UTC: option B.

## Context

Each finished span costs the request thread
real work today:

- `observer.ts` shapes OTLP: attribute arrays,
  time strings, events.
- `queue.ts` runs `JSON.stringify` and
  `encodeInto` per record, two records per span.
- `publishQueued` sets `exportHealth` with a new
  object per span.
- The queue sends batches of 64 records with
  `fetch`, on the same thread.
- The console mirror is written there too.

Measured on f275332 (start-min, 10 connections):

- Telemetry frames hold 5.3% of busy main-thread
  time on SSR `/`, 9.0% on `/api/health`.
- That is about 105 µs per SSR request and
  80 µs per JSON request.
- Under load the sink gets only 45% to 51% of
  the spans. The queue's 512 cap drops the rest.

The goal: the request thread does one cheap
write per span. A worker thread does the rest.
The sink gets the same records. The console
gets the same text.

## Precedent

- **pino transports (thread-stream).**
  The logger serializes one line and writes it
  to a `SharedArrayBuffer`. A worker thread reads
  it and owns the destination.
  Words we borrow: one write, a worker owns the
  output, the ring (a shared byte buffer with a
  write index and a read index).
- **sonic-boom.** It writes to a file descriptor
  directly and retries on `EAGAIN`.
  The worker writes the console mirror the same
  way, straight to fd 1.
- **OpenTelemetry BatchSpanProcessor.**
  `onEnd` only queues the span. Export shapes and
  sends in batches. A full queue drops the span
  and counts it. `shutdown` flushes.
  Words we borrow: drop and count, flush on
  graceful close, give up at a deadline.

Where ours is simpler:

- One exporter, one storage pair, no sampling.
- The worker runs the same queue resource the
  browser and the tests use.
- The line is our own small JSON array, not a
  log format.

## The shape both spikes share

```
request thread
  Core span ends
  observer: JSON.stringify one array
  write the line
    |
    v
worker thread (its own telemetry root)
  parse, shape OTLP (spanBody)
  queue: batch, size, cap
  delivery: fetch to storage
  console mirror: write to fd 1
  health: post back on a kind change
    or a returned send
```

- The request side resolves its typed tags
  (service, URLs, console fd) and passes them
  in `workerData`. The worker command binds them
  inline. No component reads env.
- `cmds/telemetry-worker.ts` is the worker
  command. Start's plugin builds it to
  `dist/server/telemetry-worker.js`.
- Native glue (ring reads, the port, fd writes)
  lives in `tinker/base/telemetry-worker.ts`.
  Commands may not import `node:` modules.
  (B as landed: see "How B landed".)
- `spanBody` moves to `records.ts`. The observer
  and the worker drain both call it, so the OTLP
  shape stays one function.
- A value JSON would lose (bigint, undefined,
  a function, a cycle) is encoded on the request
  side first, and the line says so.
- A test feeds one app root to the in-process
  observer and to the wire path. Storage bodies
  and console text match byte for byte.
- Only a built server uses the worker.
  Dev and tests keep the in-process queue.
  The browser does not change.

## Option A: pino transport

`pino.transport({ target })` starts the worker.
thread-stream carries the lines. The target is
the worker command; it returns a `Writable`.

- Request side: `ThreadStream.write` runs
  `Buffer.from` per line, then a flush on the
  next turn.
- Health comes back as a thread-stream `EVENT`
  message.
- New dependency for every app: pino 10.3.1 and
  its 11 direct packages.

What it took to make close safe:

- `ThreadStream.end()` waits on `Atomics.wait`,
  up to ten 1 s waits, on the request thread.
  With a storage that never answers, the host's
  10 s hard stop killed the process (exit 137).
- pino's exit hooks call `flushSync`, which also
  blocks. So `autoEnd: false`.
- Close became two messages: stop holding lines
  back, then finish once the ring is read.
- A `flush` still waiting to read never calls
  back when the worker dies. We race it with the
  worker's exit.
- `writableNeedDrain`, `closed`, `worker`, and
  `ref` are not in thread-stream's types.

Drop gate: thread-stream never drops. It keeps
lines in memory when its buffer is full. We drop
when `writableNeedDrain` is set. Its buffer is
not a ring: the write index only resets once the
worker catches up. So the gate also fires when
the worker is keeping up. It lost 0.1% to 0.2%
of spans at 10,000 requests.

## Option B: our own worker

`node:worker_threads` and a 4 MiB ring:
the thread-stream design, our own code.

- Request side: one string append per line.
  Once per event-loop turn: one `encodeInto`,
  one copy into the ring, one `Atomics.notify`.
- The worker waits with `Atomics.waitAsync`.
- A full ring drops the turn's lines and counts
  them in `exportHealth.dropped`.
- Close: post `close`, the worker reads the rest
  of the ring, closes its root (1.5 s for
  storage), posts its final health, and exits.
  The request side stops it at 3 s.
- No new dependency. The ring is about 80
  lines: the turn's copy and the worker's read.
- New code in all: B 615 lines, A 574 lines.
  A's close workarounds take the room the ring
  takes in B.
- We own wraparound, a character split at the
  wrap, and a full ring. Each needs a test.

## Measured

Method: `../start-perf/README.md`. start-min,
Node 22.22.0, NODE_ENV=production, 10
connections, 4 s warm, 15 s load. Profiler on
every thread, 100 µs. Two rounds, trees in turn.
Shares are % of busy main-thread time.
Round 1 / round 2. Data: the results README.

Trees:

- base: f275332.
- A: 9781c27 (pino transport).
- B: 8f0257c (own worker).
- B2: 9f136a7 (B, full batches only).

Request-thread telemetry, inclusive:

- SSR, inlining off:
  base 5.25 / 5.25, A 3.31 / 3.32,
  B 2.16 / 2.27.
- JSON, inlining off:
  base 8.98 / 8.89, A 6.09 / 6.05,
  B 4.28 / 4.36.
- SSR, normal run:
  base 5.61 / 5.30, A 3.18 / 3.28,
  B 2.43 / 2.25.
- JSON, normal run:
  base 9.95 / 9.55, A 6.48 / 6.70,
  B 5.45 / 5.29.

Request-thread telemetry, µs per request:

- SSR, inlining off: base 106 / 104,
  A 63 / 66, B 40 / 43.
- JSON, inlining off: base 78 / 80,
  A 49 / 50, B 34 / 36.

What is left on B's request thread (SSR):

- `JSON.stringify` of the line, inside the
  observer's `export`: about 1.0%.
- Core's lazy hex ids (`hex`), read for the
  line: 0.57%. Base pays the same.
- The append and the turn's copy: 0.3%.

A's write path (`thread-stream/` frames):
1.0% to 2.4%. B's append and copy: 0.3% to
0.9%.

Start's total, SSR inlining off:

- Self: base 4.49 / 4.28, A 3.17 / 3.53,
  B 3.31 / 3.43.
- Inclusive: base 22.3 / 22.1, A 21.1 / 21.2,
  B 20.3 / 20.6.

GC: 3.9% to 6.5% in every tree. The trees
differ by less than the rounds do.

The worker thread's own CPU (round 2):

- SSR, inlining off: A 3.5 s, B 3.3 s of busy
  time, beside 19.3 s on the main thread.
  That is 360 and 329 µs per request.
- JSON, inlining off: A 6.5 s, B 6.5 s.
  283 and 278 µs per request.
- About 45% of it is `fetch` and its streams,
  signals, and socket writes. The drain is 10%
  to 14%; then the queue and the console write.
- B2 (full batches only) cuts it to 278 (SSR)
  and 206 (JSON) µs per request.

So total telemetry CPU goes up. The base threw
away more than half the spans before sending.
The worker sends all of them, about 20 spans
per post (B2: 32).

Spans that reach the sink (4 per request,
plus 3 at startup):

- 2,000 requests: base 46% (SSR) and 51%
  (JSON). A and B: 100%.
- 10,000 requests: base 45% and 46%.
  A 99.9% and 99.8%. B 100% and 100%.
- One connection, 300 requests: all trees 100%.
- Console lines: 4 per request in every tree.

Close (200 JSON requests, then SIGINT):

- Normal storage: all trees exit in 0.2 s with
  every span sent.
- Storage that never answers: base 0.8 to
  1.5 s. A before the fix: killed at 10 s.
  A and B after the fix: 0.8 s.
- Worker file missing: A and B stop at startup,
  exit 1, "Cannot find module".
- Worker throws mid-run: every request still
  gets a 200. Spans after the throw are lost;
  health says failed. Exit stays 130.

Node 24.22.0: same bytes at the sink, worker
profiles written, close bounded.

Memory: one more V8 heap (an isolate). RSS at idle:
base 95 MB, A 119 MB, B 116 MB.

Requests per second, context only (shared box):
SSR normal round 2: base 651, A 732, B 721.

## Decision

Option B: our own worker and ring.
Duke picked it on 2026-10-20.

- It takes more off the request thread:
  telemetry falls from 5.3% to 2.2% (SSR) and
  from 8.9% to 4.3% (JSON). A reaches 3.3% and
  6.1%.
- Its drop rule is ours and plain: a full ring
  drops and counts, as BatchSpanProcessor does.
- Its close never blocks the request thread.
  A needed four workarounds on pino internals
  to get there.
- No new dependency in each app.
- The cost: we own the ring (about 80 lines)
  and its tests. A's workarounds were about the
  same size.

Keep from pino: one cheap write, a worker that
owns the output, fd writes like sonic-boom.

## How B landed

The port onto `next` (92a9b4d) keeps the
spike's design. These parts changed so the
app rules pass (`check-plain`, lint, B4):

- The ring and the worker are two resources.
  `threadRing` is the request thread's write.
  It is sync, so observers stay sync.
  `telemetryThread` starts the worker on it.
  It is async: `node:worker_threads` enters
  through a lazy module resource,
  `telemetry/modules.server.ts`, as mail's
  `node:net` does.
- Health no longer wraps `fetch`.
  The drain watches `exportHealth` and wakes
  the glue on each kind change.
  Every returned send changes the kind
  (`sending` to `queued`, `idle` or `failed`).
  So the worker binds no `httpBackend`;
  delivery uses the default `fetch`.
- Unreadable lines are counted in the drain,
  as dropped.
- The base glue is named entry helpers:
  `telemetryWorkerInput`, `write`,
  `serveTelemetryWorker`, `post`, `ringLines`,
  `takeLines`.
  `check-plain` lists them, as it lists
  `server-entry.ts`.
- The worker command has no `defineMain`.
  It is a thread entry, not a host process.
  The server's telemetry root starts it and
  owns its close.
- `spanBody` takes an `encoded` flag, not a
  function. It is one more plain function.
  issue-board is now at the cap, 17 of 17.
- issue-board gets the same files and the same
  four bindings in `cmds/server.ts`.
- The registry's `app` item lists
  `cmds/telemetry-worker.ts`.
  `telemetry` lists `modules.server.ts`.
- The worker polls the ring every 10 ms.
  The request side calls `Atomics.notify`
  only once a quarter of the ring is unread.
  A wake per turn cost more than the copy:
  `push` held 4.2% of request-thread time.
  It held 0.4% in the spike, on a quieter box.
- The worker stops taking lines at 384
  pending records, not 448.
  A turn of 64 lines adds up to 128 records,
  so 448 could pass the queue's 512 cap.
  At 448, 24 of 30,002 spans were lost.
- The worker inherits Node's flags.
  Under `node --input-type=module -e`, a
  worker file fails to load. So the request
  side drops `--input-type` when it is set.
  It passes no list otherwise: a given list
  is checked, and V8 flags such as
  `--max-inlined-bytecode-size` fail it.

## What changes

Contracts:

- The server command picks the worker when
  built: `threaded = !import.meta.env.DEV`.
  Four bindings change with it.
- Start's starter text (`server-source.mjs`)
  and its test copy follow the command.
- `consoleOutput` sinks may carry an `fd`.
- `exportHealth` on the request side changes
  only when the worker's kind changes.
  `pending` lags between reports.
- Console lines go to fd 1 from the worker.
  Their order against the host's own stdout
  lines is not fixed. A write over 4 KiB to a
  pipe can interleave with one from the main
  thread.

Tests:

- The wire test feeds one app root to the
  in-process observer and to the real ring.
  Storage bodies and console text match.
- The built-worker tests run
  `dist/server/telemetry-worker.js`:
  every span and line arrives;
  lines that wrap the ring arrive whole;
  a turn larger than the ring drops and counts;
  a stuck storage still closes in time;
  a missing worker fails start.
- They need `vp build` first.
  CI builds every app before its tests.

## Settled questions

Each is the default, the lead's pick, and
open to change.

1. Dev server: it keeps the in-process
   queue.
2. Health: the in-process path keeps its
   per-span counts (10 tests expect them).
   The worker path reports on a kind change.
3. Server batches: the spike's rules stay
   (64 records, drain while queued). Not B2:
   it fails 3 tests that expect a batch's tail
   before the 1 s tick.
4. `fetch` stays.
5. A dead worker stays failed until the
   process restarts, as pino's transport does.
   Health says failed. Later lines are dropped
   and counted.
6. The console mirror still waits on storage.

## Follow-ups

- Delivery on `http.request` with a
  keep-alive agent. `fetch` is about half of
  the worker's time.
- The console mirror stops waiting on
  storage. With a stuck storage it keeps about
  506 of 803 lines (base: 647 to 665).
- Full batches only (B2), once the 3 tests
  are rewritten for it.

## Measured on the port

Method: as above, with the spike's scripts.
start-min, Node 22.22.0, inlining off,
10 connections, 4 s warm, 15 s load.
Two rounds, base and own in turn.
Requests: autocannon's exact totals.
CPU shares only; no timing claims.
The box ran at load 6 on 4 cores.

Trees:

- base: `next` at 92a9b4d.
- own: 1b40b0f (this change before the 384
  gate, which touches only the worker).

Request-thread telemetry, inclusive,
round 1 / round 2:

- SSR: base 4.66 / 4.94%,
  own 1.69 / 1.77%.
- JSON: base 8.58 / 9.11%,
  own 3.92 / 3.71%.

Request-thread telemetry, µs per request:

- SSR: base 127 / 139, own 43 / 47.
- JSON: base 104 / 116, own 48 / 49.

The worker thread's own busy time:

- SSR: 2.8 s / 2.6 s (361 / 351 µs
  per request).
- JSON: 4.2 s / 4.2 s (265 / 289 µs
  per request).

Spans that reach the sink (435fbac and
its tree, 3 per request plus 2 at start):

- 2,000 requests: base 3,563 (SSR) and
  3,643 (JSON) of 6,002. Own: 6,002 both.
- 10,000 requests: base 19,008 and 19,191
  of 30,002. Own: 30,002 both, two runs.
- 300 requests, 1 connection: 902 of 902
  in both trees.
- Console lines: 3 per request plus 2,
  in both trees.
- Close: normal storage 0.2 s, exit 130.
  Storage that never answers: 1.0 s,
  exit 130.

Data: `perf-swarm/telemetry-worker-b/`.
