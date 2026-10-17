---
name: tinker-sync
description: Choose mutations and sync for saved state.
---

# Saved changes and waits

Read the [current authoring contract](https://github.com/lagz0ne/tinker-app/blob/next/docs/decisions/start-decompose.md) for owned calls, auth,
stream creation, and transactions. Use sync for committed shared state; keep
drafts and view choices in data. Read-only page/bootstrap calls never write.

Read saveName in src/frontend/profile-actions.ts. It makes an execution ID with
ctx.random.uuid and registers sync.execute before sending the native server
function. Pass the native send function and its plain data record directly.
Do not wrap it in a signal-taking helper. Saved events update records; a final
result ends the wait. Do not patch saved records from a command receipt.

A lost reply retries the same execution ID. A separate mail retry uses a new
ID. Results distinguish a complete save, a saved value with failed required
mail work, and a failed save. The profile mail demo is a legacy flow; new board
mail uses an outbox row in the write transaction.

Sign-in holds reconnects with snapshotLoader.beginAccountChange, registers
endAccountChange in defer, leaves sync, then awaits completeAccountChange before
releasing the hold. Account exit cancels waits and ignores old replies.
The page shell's AuthSession keeps active logins fresh through explicit POST;
that does not move a write back into bootstrap.

Read src/demo/contracts/sync.ts for bodies and tests/sync.test.ts for the public
result. Stream/account checks use auth's public server entry.
