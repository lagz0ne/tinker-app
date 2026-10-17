---
name: tinker-feature
description: Add a feature from its table to its page.
---

# Add one feature

Read the [current authoring contract](https://github.com/lagz0ne/tinker-app/blob/next/docs/decisions/start-decompose.md) for imports, ownership,
input checks, and commit-before-success. Use the board's issue operations as
the new session-transaction write example. Todos still has a native transaction;
use it for the feature/data path, not for new transaction ownership.

Read this path in order:

1. src/demo/backend/todos.schema.server.ts and src/demo/contracts/todos-contract.ts.
2. src/demo/backend/todos.server.ts and src/demo/backend/sync.server.ts.
3. src/transport/todos.functions.ts and src/demo/contracts/sync.ts.
4. src/demo/frontend/records.ts, src/frontend/Todos.tsx, and src/routes/todos.tsx.
5. tests/todos.test.ts and tests/presets.ts.

Add the schema to drizzle.config.ts and generate its migration. Take the actor
from currentUser rather than caller input. Keep execution replay guards, stream
lock order, saved changes, and events in one write transaction. A repeated
execution ID must not repeat saved effects. Run each shared step through a
controller so it has a span. The transport owns the child call and its signal.

Private page guards call context.account and context.bootstrap. They only read.
Keep drafts separate from saved data. Extend Register and the event reader
before adding a page. Views invoke operations and show checked results.

Run build, type checks, serial tests, schema, and the listed app gates.
