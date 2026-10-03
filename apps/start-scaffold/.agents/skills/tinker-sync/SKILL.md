---
name: tinker-sync
description: Choose mutations and sync for saved state.
---

# Saved changes and waits

Use this when adding a save or a shared view.
A mutation asks the server to change saved state.
Sync carries that saved change to every allowed view.
A draft or a local view setting needs only local data.
A read with no shared saved state can use a read operation.

See `saveName` in `src/frontend/actions.ts`.
It makes an execution ID with `ctx.random.uuid()`.
`sync.execute` registers the wait before sending.
The server returns that ID as its receipt.
Saved events update data, then the final result ends the wait.
Remote events update data without a local wait.
Never patch saved records from the mutation receipt.

Results describe the operation's required work:

- Complete: all required work finished.
  Todos finish at commit.
- Partial: some required work finished.
  Profile commit passed but mail failed.
  Keep the saved name usable and offer mail retry.
- Failed: required work failed before a usable save.
  Show the failure and keep the old saved record.

See `src/contracts/sync.ts` for the exact bodies.
Retry uses the same execution ID for a lost reply.
Mail retry uses a new ID and keeps the old profile save.
Account exit cancels waits and ignores old responses.
Keep drafts apart from saved records.
