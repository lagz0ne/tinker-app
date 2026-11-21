# Task, step 3: archive a team; comments go

You built the issue board in steps 1 and 2. Your code
is in this folder. `TASK-ck1.md` and `TASK-ck2.md` are
the tasks before this one. They still hold, except
where this file says a part goes.

You work in this folder only. Do not read files outside it.

## What is new

These given files changed. Do not change them:

- `src/issues/contract.ts`: no comments, a new part
  `archived`, a new call `team.archive`, and a new
  answer `{ kind: "archived" }` on the other calls.
- `src/issues/index.ts`.
- `src/routes.tsx`: no thread route.

Change your own files: the ops, the pages, your tests.
`src/issues/board.tsx` exports `IssuesHome` and
`Board`.

## What goes

- Comments: the part, the call `comment.add`, the
  thread page, its tests. S4 and P3 of step 1 go.
- The card link to `/issues/<team>/<id>`. That page
  is gone.

Remove them. Do not keep code that nothing uses.

## Server journeys

S9. A member can archive their team.

- `team.archive` answers `{ kind: "archived" }`. A
  second archive answers the same.
- After it, every change to the team answers
  `{ kind: "archived" }` and writes nothing:
  `team.add`, `issue.create`, `issue.move`,
  `issue.rename`.
- The members still read the team: its parts stay
  ready, its issues stay as they were.
- A caller who is not in the team gets `gone`, from
  `team.archive` too. They do not learn that the
  team is archived.
- Another team is not changed by this one.

S5 changes: a read of a team's part by a non-member
is refused for each part: members, issues, archived.

## Page journeys

P2 changes: each card is an `article` named by its
key (`aria-label="ENG-1"`). It shows the key, then the
title. No link.

P6. A button `Archive team` on the board.

- A change after the archive shows a status (one per
  answer that is not a success), and the cards stay.

## Rules your server keeps

R1 to R8 of step 2 hold. R9 goes. These change:

- R2. The read hook refuses a non-member for each
  part: members, issues, archived.
- R4. An answer of `gone`, `stale`, `exists` or
  `archived` writes nothing. (An archive of a team
  that is archived already writes nothing too.)
- R8. The member check runs before any issue is read,
  and before the archive mark is read.

Judge your server again. Write `RULES.md` again.

## Done means

The same as before. Hidden tests check the journeys
of steps 1, 2 and 3 that still hold.
