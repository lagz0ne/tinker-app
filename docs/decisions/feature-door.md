# A feature is one folder with one door

Date: 2026-11-10. Status: accepted; built.
Accepted: Duke, 2026-11-10 03:11 UTC.

## What Duke said

- 00:00: "User app is just bunch of capsules,
  frontend and backend. Make use of all new
  rpc and remote data."
- 03:11: "surely we must go to C, that the
  purpose of capsule, and reexports, single
  point to access."

## Precedent

- **DDD bounded context, modular monolith**
  (Shopify packwerk): a module has one public
  door; others never import its insides.
- **CQRS**: reads are a read model, writes are
  commands. Here: `remoteData` and `rpc`.
- **Hedl's `work` capsule**: a capsule whose
  exports are read views.

## Decision

1. A feature is one folder in `src/`.
2. `index.ts` is its door: one `capsule()`,
   plus plain re-exports of its pages.
3. The capsule exports the feature's board
   (remote data) and api (rpc).
4. `index.server.ts` is the server door: the
   ops behind the api. Only the server
   imports it.
5. Others import `@/<feature>` or
   `@/<feature>/index.server` only. Lint
   (`no-restricted-imports`) refuses a deeper
   path. Inside its folder, a feature uses `./`.
6. Another feature reads a list through
   `todo.board.todos`, a read view (tinkered
   ADR 0123). It changes the list only by a
   call on `todo.api`.
7. The cmds install the board and the api.
   The door is not installed: it carries
   names, and a capsule cannot install other
   capsules.

## Proof

- `tests/todo-feature.test.ts`: a `stats` op
  reads the list through the door on both
  sides; `todo.board.todos.controller` is a
  type error and undefined.
- A probe file with
  `import { todos } from "@/todo/contract"`
  fails lint.

## Found

- A capsule cannot export another capsule's
  read view (`todoBoard.todos`): the type
  refuses an edge in `exports`. So the door
  exports the board itself, and readers write
  `todo.board.todos`.
- The raw `todos` cell is not the tab's copy:
  the board's read lands on its own view. Read
  through the board, never the raw cell.
