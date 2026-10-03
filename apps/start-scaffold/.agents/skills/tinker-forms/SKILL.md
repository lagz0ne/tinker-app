---
name: tinker-forms
description: Choose the owner of new app code.
---

# Choose a form

Read this before adding app code.
Choose one form for each piece of work:

- Tag: fixed settings passed in by the entry.
  See `databaseSettings` in `src/backend/database.ts`.
- Data: changing records, drafts, and visible progress.
  See `profile` and `nameDraft` in `src/frontend/state.ts`.
- Resource: a client or work owned by the app or session.
  See `database` and `auth` in `src/backend/`.
- Operation: an action, including a read, write, or send.
  See `changeTodo` in `src/backend/todos.ts`.

Load a native library inside its resource factory.
Release owned clients with `ctx.defer`.
Use `ctx.signal`, `ctx.clock`, and `ctx.random`.
Use a `kind` union when states hold different values.

Code outside these forms needs a TSDoc reason beside it.
Say why none of the four forms can own that work.
React views render data and invoke operations through hooks.
Readers validate raw input once at the door.
Never pass a scope or context bag to a helper.
