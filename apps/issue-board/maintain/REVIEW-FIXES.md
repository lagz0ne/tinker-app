# Slice 7 review fixes

Base: 9dc7dcad6bd4060e555a4f780ccfe9d58f04545f. One new commit; do not amend the base.

- F1: server startup owns config errors before generic close handling; missing
  database config is checked through the real command and returns 78.
- F2: CLI TeamChanged is temporary failure 75. Bad rows stay 65.
- F3: 201 CSV rows, bad row at index 150, inside batch 2. The first 50 writes in
  that batch must roll back. A per-row scratch runner must fail that assertion.
- F4: any failed BEGIN, COMMIT, or ROLLBACK sets broken; release(true) discards
  that connection. Tests also cover failed COMMIT followed by failed ROLLBACK.
- F5: one leaseFrom implementation serves production checkout, PGlite, and the
  native PostgreSQL proof adapter. Copies are gone. The shared checkout has
  controls for lazy checkout, BEGIN ordering, typed ended errors, and forwarding release(true).
  release(transaction) and cancel each have their own rollback proof/control.
- F6: tx.transaction throws NestedTransaction before any nested BEGIN/COMMIT.
- F7: reason checks run outside main. Fake-timer tests check the full grace
  delay and clean timer removal. Each has a broken-copy control; reason does too.
- F8: worker cancellation closes its root. The worker call has its own child
  session so a rejected cancellation does not fail the root before cleanup.
- F9: open limit 37. Cursor initialization is still in the bootstrap path.
  Moving it needs public/account stream creation and migration/auth rules.
  This is not small. No render-path workaround or silent exception was added.
- F10: the shared-write import moved to the relative group at the top.

- N1: step inputs use Zod schemas; no unchecked raw-as readers or inline Zod imports.
- N2: server uses the base checkClosed; the ended copy is removed.
- N3: clean CLI cancellation closes first and prints no import-failed line.
- N4: restore the membership-insert and future-removal invariant comment.
- N5: document why the import update is covered by the team row lock.
- N6: team.lock returns member emails; import.assignees and its extra query are removed.
- N7: explicit ends return one handled promise; defer rethrows its failure.
  A dropped explicit COMMIT rejection cannot turn the call into success.
- N8: decision 3 and REFACTOR say one worker session per claimed batch.
- N9: keep issues.delta as the pure formatting span allowed by decision 4.
- N10: run the plain checker and planted cases. Add cases for local resource
  returns, foreign helper rejection, resource method options, and real/fake
  defineMain. Add missing native uuid/smallint/bigserial and Zod pipe/omit
  declarations; this closes the old schema gate gaps without raising the cap.
- N11: stop aborts LISTEN waits and worker pool reads. Pool-read clients are
  destroyed on stop; pending handshakes have a tagged 5-second connection
  bound below the default host grace. In-flight delivery transactions keep
  their soft-stop rule. Black-holed handshake tests require close before grace.

Native command controls replace only the failure operation in a scratch module.
The commands, Core, roots, close handling, and exit mappings are the real code.
App unit tests use real command startup or scope presets, without module mocks.

## Lead notes

- L1: done. Server uses checkClosed from the base; no ended copy.
- L2: done. Imports are at the top in four groups.
- L3: done. issues.save calls issues.read, issues.place, issues.rank,
  issues.create, and issues.update through controllers. import.saveRow calls
  import.readRow, import.place, import.create, and import.update. Each uses
  plain await. Lock order, sequence increments, replay and version guards,
  stream events, and outbox writes stay inside the same call transaction.
- L4: done. Every listed step input has a Zod schema.
- L5: done. Resolving the transaction builds only a lazy lease handle. The
  BEGIN query inside begin() first calls the pool connector. An unused handle
  acquires and releases no client. First queries share one checkout promise.
  Unit tests count checkout/release; the shared native checkout proof has an
  eager-checkout broken-copy control.

Checks after the lead changes: 386 app tests passed serially; all eight
transaction proofs passed, including the extra released-session check.
All 33 broken-copy controls failed as intended. The issue/import lock races,
comments, outbox, SMTP login, worker host, digest, and command-exit proofs passed.
Server/worker/CLI builds, types, doctor, schema, style, and plain check passed.
The earlier full checker suite passed all 234 planted cases; its rules did not
change in these lead fixes.
