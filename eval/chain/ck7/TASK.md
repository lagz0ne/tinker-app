# Task, step 7: history

You built the issue board in steps 1 to 6. Your
code is in this folder. `TASK-ck1.md` to
`TASK-ck6.md` are the tasks before this one. They
still hold, except where this file says a part
changes.

You work in this folder only. Do not read files outside it.

## What is new

`src/issues/contract.ts` is given again. Do not
change it. It has:

- a new part `events`: the history of each issue,
  one event for each version;
- `changes`: what a change did (`created`,
  `moved`, `renamed`, `labeled`, `assigned`);
- `issue`, the shape of one issue, now exported.

Change your own files: the ops, the pages, your tests.

The files given in step 1 stay given. Do not change
them: `src/issues/sign-in.ts`, `src/issues/index.ts`,
`src/routes.tsx`, `cmds/**`. Put a new cell or op in
a file of your own.

## Server journeys

S14. Each change of an issue leaves one event.

- The rule: every change of an issue that
  succeeds, now and in later steps, writes one
  event. Find each place that changes an issue.
- The event has the issue's new `version`, `by`
  (the caller), and `what` it did.
- An answer that is not a success leaves no event.
- A change that is not of an issue (a member
  added, the team archived) leaves no event.
- An event is never changed.
- The other tabs of the team see the events.

S5 changes: a read of a team's part by a non-member
is refused for each part: members, issues,
archived, labels, events.

## Page journeys

P11. A region `History` on the board.

- One list item per event of the team:
  `ENG-1 v2 moved by bo`.
- In order of the issue's number, then the version.
- It is live.

## Rules your server keeps

R1 to R8 hold. These change:

- R2. The read hook refuses a non-member for each
  part of a team: members, issues, archived,
  labels, events. A part of `members` by `userId`
  alone goes only to that user. A user may always
  read their own member rows.
  Core asks again for one member row by its whole
  key `{ teamId, userId }`. Another user's row
  then takes the team check, as the team's part
  does.
- R4. An answer that is not a success writes
  nothing: no issue, no label, no event.

Judge your server again. Write `RULES.md` again.

## Done means

The same as before. Hidden tests check the journeys
of steps 1 to 7 that still hold.
