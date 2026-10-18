---
name: tinker-testing
description: Prove app promises through small scopes.
---

# Test through a scope

Read the [current authoring contract](https://github.com/lagz0ne/tinker-app/blob/next/docs/decisions/start-decompose.md#http-and-tests) for the shared
check rules. Tests stay serial with VITEST_MAX_WORKERS=1 and
VP_RUN_CONCURRENCY_LIMIT=1. Never skip or quarantine a test.

Read tests/todos.test.ts, bootstrap-read.test.ts, transaction.test.ts, and
transaction-lease.test.ts. Tests bind typed tags and use native resource presets.
proofDatabase runs real PGlite queries; proofMail records sends. Tests may import
the private owner they prove. Never patch global fetch, clocks, or module state.
Use Core's test clock and resource presets at those native boundaries.

New write tests use the same owned call as a transport: a signal opens a child
session and joins defer before the result. Prove failed COMMIT, no early reply,
rollback, idle no-checkout, and ended handles. Do not mirror each internal step.
Keep command tests for input, startup, exit, and close; these are useful wiring
contracts. Native host proofs stay outside feature scope tests.

Old/expired-cookie page tests log all SQL writes. The browser refresh proof must
show an aged login renews through successful POST, rather than manually sending
the refresh from the test. A fault control must fail for its named cause.
Run the app's AGENTS.md gates and live proofs. Build before type checks/tests.
