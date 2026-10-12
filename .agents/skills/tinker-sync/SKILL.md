---
name: tinker-sync
description: Choose mutations and sync for saved state.
---

# Saved changes and waits

Omit `.ts`, `.tsx`, and `.mts` endings in imports and exports.

Use this when adding a save or a shared view.
A mutation asks the server to change saved state.
Sync carries that saved change to every allowed view.
A draft or a local view setting needs only local data.
A read with no shared saved state can use a read operation.

See `saveName` in `src/frontend/auth-actions.ts`.
It makes an execution ID with `ctx.random.uuid()`.
`sync.execute` registers the wait before sending.
Pass the native send function with its data record:

```ts
const executionId = ctx.random.uuid();
const completed = await sync.execute(
  executionId,
  {
    send: updateProfile,
    data: { executionId, profile: ctx.input },
  },
  ctx.signal,
);
```

Do not add a signal-taking helper around the native send.
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

Every sign-in action must hold reconnects during auth.
Depend on `snapshotLoader` from
`@tinker/start/client` as `snapshots`.
Follow `signIn` in `src/frontend/auth-actions.ts`:

```ts
const change = snapshots.beginAccountChange();
ctx.defer(() => snapshots.endAccountChange(change));
sync.leave();
```

After auth succeeds, apply its snapshot before releasing:

```ts
await snapshots.completeAccountChange(ctx.signal, change);
```

Skipping this hold can load the snapshot twice.
