# Review decisions

These rules cover slice 7 and its refactor. Review fixes keep Core unchanged.

1. Commands use defineMain and MainContext. Only commands choose exit codes.
   Codes are 0 success, 1 unexpected error, 64 usage, 65 bad data, 75 temporary
   failure (including TeamChanged), 78 startup config, 130 SIGINT, 143 SIGTERM.
   The host keeps the first code, aborts the signal, joins closed, flushes output,
   and sets process.exitCode. Only its grace deadline may force a stop.
2. The session transaction checks out a client and begins lazily on its first
   query. Success commits; failed, cancelled,
   or released ends roll back. An end is safe to repeat. Ended queries and nested
   transactions fail. Failed BEGIN/COMMIT/ROLLBACK destroys the checked-out client.
   Explicit commit/rollback must be awaited; defer also joins their result.
3. Each server-function call and CLI batch has a child session that closes before
   response or progress output. The worker has one child per claimed delivery
   batch, rather than per whole polling pass. That keeps row locks short. Mail
   stays an outbox row inside the transaction. There is no afterCommit hook.
   Page-render writes remain prohibited. Limit 37 is closed: account streams
   are created at sign-up, the public stream is seeded by migration, and
   bootstrap only reads a repeatable snapshot.
4. Writes use controller steps and shared lock/event/outbox operations. A pure
   formatting step may remain an operation to show its own trace span.
5. Imports stay at the top: external, copied base/components, app, relative.
   Tests run serially. Proofs must fail on the broken case they name.

Duke's final performance direction assumes performance is the same. Keep the
saved flamegraphs. Do not run new profiles or timing comparisons.

Auth directly depends on sync account operations and the mail queue. Hooks keep
operation spans under the scope-owned auth build span; mail sends stay under
mail.authWork. There are no hook tags, saved context, or AsyncLocalStorage.
The auth-bound stream file moves into auth so components do not form a loop.

Accepted F1: during graceful shutdown, auth hooks are refused with `Disposed`; sign-in can error after commit and the next sign-in repairs the stream row; a lost sign-out notice is harmless because streams close.
