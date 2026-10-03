---
name: tinker-feature
description: Add a feature from its table to its page.
---

# Add one feature

Use todos as the worked path.
Read these files in this order:

1. `src/backend/todos.schema.ts`: the feature table.
2. `src/contracts/todos.ts`: input reader and row type.
3. `src/backend/todos.ts`: scoped read and write operations.
4. `src/backend/sync.ts`: private snapshot and saved events.
5. `src/transport/todos.functions.ts`: Start function.
6. `src/contracts/sync.ts`: change and result bodies.
7. `src/frontend/records.ts`: apply changes to saved data.
8. `src/frontend/Todos.tsx`: page and action.
9. `src/routes/todos.tsx`: account guard.
10. `tests/todos.test.ts`: scope tests for the public promise.

Add your table to `drizzle.config.ts`.
Generate and keep its migration:

```bash
npm run db:generate
```

A private operation depends on `currentUser`.
Take the owner from that user, never from caller input.
Use `eventHistory` from `src/scaffold/backend/events.ts`.
In one transaction, `lock` orders writes to the stream.
`find` checks the execution ID before any saved effect.
`append` stores the events with the saved change.
See `changeTodo` in `src/backend/todos.ts`.
A repeated execution ID must not repeat saved effects.

Export backend operations from `src/backend/index.ts`.
Tests import `@tinker-start-scaffold/backend`.
Export frontend operations from `src/frontend/index.ts`.

Use this private guard from `src/routes/todos.tsx`:

```ts
beforeLoad: async ({ context }) => {
  if ((await context.account()) === null) {
    throw redirect({ to: "/" });
  }
  await context.bootstrap();
},
```

Extend `Register` through `src/lib/tinker.ts`.
Add data and its change reader before adding the page.
Run the build, types, tests, and schema check.
