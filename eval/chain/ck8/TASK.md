# Task, step 8: delete a team

You built the issue board in steps 1 to 7. Your
code is in this folder. `TASK-ck1.md` to
`TASK-ck7.md` are the tasks before this one. They
still hold, except where this file says a part
changes.

You work in this folder only. Do not read files outside it.

## What is new

`src/issues/contract.ts` is given again. Do not
change it. It has a new call `team.delete`.

Change your own files: the ops, the pages, your tests.

The files given in step 1 stay given. Do not change
them: `src/issues/sign-in.ts`, `src/issues/index.ts`,
`src/routes.tsx`, `cmds/**`. Put a new cell or op in
a file of your own.

## Server journeys

S15. A member can delete their team.

- It answers `{ kind: "deleted" }`.
- Every part of the team goes: each part you built
  in steps 1 to 7. Nothing of it stays.
- An archived team can be deleted too.
- Outside the team: `gone`. A viewer: `forbidden`.
  Nothing is written.
- A team made again with the same key starts empty:
  issue numbers from 1, no labels, no events, not
  archived, only its new maker as a member.
- A tab that reads the team is told it is not in
  the team any more. A person's own list of teams
  drops it.
- Another team is not changed by this one.

## Page journeys

P12. A button `Delete team` on the board. After the
delete, the page opens `/issues`.

## Rules your server keeps

R1 to R8 hold. These change:

- R4. An answer that is not a success writes
  nothing.
- R8. The member check runs before any part is
  read, also in a delete.

Judge your server again. Write `RULES.md` again.

## Done means

The same as before. Hidden tests check the journeys
of steps 1 to 8 that still hold.
