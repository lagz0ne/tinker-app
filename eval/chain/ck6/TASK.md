# Task, step 6: assign; my issues

You built the issue board in steps 1 to 5. Your
code is in this folder. `TASK-ck1.md` to
`TASK-ck5.md` are the tasks before this one. They
still hold, except where this file says a part
changes.

You work in this folder only. Do not read files outside it.

## What is new

These given files changed. Do not change them:

- `src/issues/contract.ts`:
  - an issue has an `assignee` (none at first);
  - a new call `issue.assign`;
  - a person reads their own teams with
    `members.where({ userId })`.
- `src/routes.tsx`: a new route `/issues/mine`.
  `src/issues/board.tsx` exports `MyIssues`, with
  `IssuesHome` and `Board`.

Change your own files: the ops, the pages, your tests.

The files given in step 1 stay given. Do not change
them: `src/issues/sign-in.ts`, `src/issues/index.ts`,
`src/routes.tsx`, `cmds/**`. Put a new cell or op in
a file of your own.

## Server journeys

S12. A member can assign an issue.

- An assignment is a change of the issue. It names
  the version it saw, as a move does.
- It answers `{ kind: "assigned", version }`. A
  move, a rename, a label change and an assignment
  count one version.
- `userId: null` takes the assignee off.
- The assignee must be a `member` of the team. A
  viewer, or a person outside the team, answers
  `{ kind: "notAssignable" }`.
- It answers as every change does: `gone`,
  `forbidden`, `archived`, then `stale`. The
  assignee check comes last.

S13. A person reads their own place in every team:
`members.where({ userId })`, live.

- A team that adds them shows at once.
- That part goes to that person only. Any other
  caller is refused.

## Page journeys

P9. Each card has a select `Assignee of ENG-1`. Its
options are `nobody`, then each `member` of the
team (not a viewer), sorted. A choice assigns the
issue.

P10. `/issues/mine`, the heading `My issues`.

- One region for each team the person is in,
  named by its key, in order of the key.
- In each, an article for each issue assigned to
  the person, named by its key (`WEB-1`).
- It is live: a new team, a new assignment, or an
  assignee taken off shows at once.

## Rules your server keeps

R1 to R8 hold. These change:

- R2. The read hook refuses a non-member for each
  part of a team: members, issues, archived,
  labels. A part of `members` by `userId`
  alone goes only to that user. A user may always
  read their own member rows.
  Core asks again for one member row by its whole
  key `{ teamId, userId }`. Another user's row
  then takes the team check, as the team's part
  does.
- R4. An answer that is not a success writes
  nothing.

Judge your server again. Write `RULES.md` again.

## Done means

The same as before. Hidden tests check the journeys
of steps 1 to 6 that still hold.
