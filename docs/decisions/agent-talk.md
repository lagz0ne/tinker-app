# A scope owns an agent talk

Date: 2026-10-31. Status: accepted.
Asked by: Hedl on Tinker, gap TG2 (#41).
Duke, 2026-10-26: no workarounds in Hedl;
a Tinker gap is fixed in Tinker.
Builds on: `start-decompose.md` (seams,
lazy module resources, close before
success), `sqlite-variants.md` (a component
Hedl needs ships in the scaffold).

## Context

Obelisk (the old Hedl) runs its own Claude.
Hedl is a 1:1 port, so it needs the same.
Obelisk's engine is `lib/talk.mjs`.
Its store is `lib/talkstore.mjs`.

What obelisk does today:

- A talk is a thread: one guide per project,
  and works (`w<n>`) that the guide opens.
- A turn is one `query()` with a string
  prompt. It resumes the thread's SDK
  session with `resume: <session id>`.
- A lost session is retried once,
  without `resume`.
- Each turn gets its own `AbortController`.
  Stop and server close abort it.
- One run per thread. At most 3 runs in all.
  The rest wait in a FIFO queue.
- The stream (`init`, `stream_event`,
  `assistant`, `user` tool results,
  `compact_boundary`, `result`) becomes
  stored items, and the page gets them by SSE.
- Claude Code gets a clean env: `PATH`,
  its own `HOME` and config dir, the cache
  variables, and one credential.
  The server's own env never goes through.
- Keep-warm: after a big guide turn, quiet
  "ping" turns resume the same session every
  50 min for 3 h. That keeps the prompt cache
  (the server-side copy of the prompt start)
  warm. Then a tidy turn compacts the talk.
- Not signed in: the turn ends with
  `NOT_SIGNED_IN` and `query()` is not called.

Tinker has no component where a scope owns
such a run. So a closed scope can leave a
Claude process alive.

## Precedent

- **Claude Agent SDK `query()`.**
  `options.abortController` ends the run and
  its child process. `Query.close()` does the
  same. Obelisk pins `0.3.295`.
- **Core resources own lifetimes.**
  `ctx.closing` aborts on a graceful close too
  (ADR 0104). `defer` joins the work.
  `telemetry/thread.server.ts` owns a worker
  this way. `mail/mail.server.ts` merges a
  caller's signal with `closing`.
- **Lazy module resources** at the native
  seam (`mail/modules.ts`). Tests preset them.
- **Obelisk's `fakeQuery`** yields the real
  message shapes and honours the abort.

## Decision

Add the `agent-talk` component:
`tinker/components/agent-talk/`.

- `agentSdk`: a lazy module resource for
  `@anthropic-ai/claude-agent-sdk@0.3.295`.
  Apps build their in-process MCP servers
  with its `createSdkMcpServer` and `tool`.
  Tests preset it with a fake. That fake is
  the seam; no test calls the real API.
- `agentTalk`: a resource with
  `target: "scope"`. It owns every run, wait
  and keep-warm timer. Close aborts them all
  and joins them before the scope is closed.
- One call per turn: `run(talk, turn)`.
  It returns a result promise that never
  rejects. Each result has a known `status`:
  `done`, `failed`, `stopped`, `closed` or
  `busy`.
- `stop(talk)` aborts that talk's run only.
- `warm(talk, plan)` runs quiet ping turns on
  the scope clock until the plan's end time.
  A new `run` on that talk cancels the plan.
- The component keeps no session ids.
  The app stores them and passes `resume`.
  This keeps two talks apart and survives
  a restart.
- The component fixes the safe options:
  `permissionMode: "dontAsk"`,
  `settingSources: []`, partial messages on,
  its own env and abort controller.
  The app sets model, prompt, tools, MCP
  servers, turns, effort and `cwd`.

Credentials enter as tags at the cmd:
`agentCredentials` holds an OAuth token or
an API key, never both. The cmd picks the
OAuth token first, as obelisk does.
The component never reads `process.env`.
It never logs, traces or returns a credential.
Error text that holds one is redacted.

### Stays in Hedl

These are Hedl's domain, not a Tinker gap:

- The talk store. It is Hedl data on
  `database-sqlite` (gap TG0): threads, items,
  notes, the saved session id, the warm plan.
- Guide and work kinds, their tools and
  prompts, the queue that merges messages
  into one prompt, the 150 ms write throttle.
- The tidy turn. Hedl runs it with `run` when
  `warm` ends.
- Re-arming a saved warm plan on restart:
  Hedl calls `warm` again from its store.
- SSE to the page (the store's change feed).

## Invariants

1. Close during a stream ends the run with
   `closed`. Its process is gone before
   `close()` returns.
2. No run, wait or timer outlives its scope.
   After close, `run` returns `closed` and
   never calls `query()`.
3. Two talks never share state: their events,
   results, stops and warm plans stay apart.
   Two scopes never share a run.
4. One run per talk at a time. A second
   `run` returns `busy` at once. A `run`
   right after `stop` is `busy` until the
   stopped run settles.

Known limits:

- `release(agentTalk)` aborts and joins its
  runs, but Core's `release` returns before
  that join. A `resolve` at once makes a new
  talk set, whose cap and lines start fresh,
  so for a moment the old and new queries can
  overlap. Release is for shutdown, not for
  a swap while live.
- Redaction holds back a credential's start
  only inside one text block. A credential
  split across two blocks gets through the
  per-block deltas.

## Settled questions

- Duke, 2026-10-31: "Ship it in the demo".
  The demo template copies every component,
  so a new demo app installs the SDK and one
  platform binary (about 256 MB), as the
  SQLite parts ship.
- The live proof needs a paid key. CI has
  none, so `test:agent-live` runs by hand.
  With no key it prints "not run" and exits 0.
