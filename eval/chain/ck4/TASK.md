# Task, step 4: a viewer role

You built the issue board in steps 1, 2 and 3. Your
code is in this folder. `TASK-ck1.md`, `TASK-ck2.md`
and `TASK-ck3.md` are the tasks before this one. They
still hold, except where this file says a part
changes.

You work in this folder only. Do not read files outside it.

## What is new

`src/issues/contract.ts` is given again. Do not
change it. It has:

- a `role` on each member: `member` or `viewer`;
- a `role` in the input of `team.add`;
- a new answer `{ kind: "forbidden" }` on every
  change: `team.add`, `issue.create`, `issue.move`,
  `issue.rename`, `team.archive`.

Change your own files: the ops, the pages, your tests.

## Server journeys

S10. A member can add a person as a viewer.

- A viewer reads the team as a member does: its
  parts stay ready.
- Every change by a viewer answers
  `{ kind: "forbidden" }` and writes nothing.
- The person who makes a team is a `member`.

The order of the checks on every change:

1. not in the team: `gone`;
2. a viewer: `forbidden`;
3. the team is archived: `archived`.

So a viewer of an archived team gets `forbidden`.

## Page journeys

P2 changes: the member form has a select `Role`,
with the options `member` and `viewer`. It starts at
`member`.

P7. A viewer sees the board and its cards.

- A change by a viewer shows a status (one per
  answer), and the cards stay.

## Rules your server keeps

R1 to R8 hold. These change:

- R4. An answer of `gone`, `stale`, `exists`,
  `archived` or `forbidden` writes nothing.
- R8. The member check runs before any issue is
  read, before the role is used, and before the
  archive mark is read.

Judge your server again. Write `RULES.md` again.

## Done means

The same as before. Hidden tests check the journeys
of steps 1 to 4 that still hold.
