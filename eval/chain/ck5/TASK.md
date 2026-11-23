# Task, step 5: labels

You built the issue board in steps 1 to 4. Your
code is in this folder. `TASK-ck1.md` to
`TASK-ck4.md` are the tasks before this one. They
still hold, except where this file says a part
changes.

You work in this folder only. Do not read files outside it.

## What is new

`src/issues/contract.ts` is given again. Do not
change it. It has:

- a new part `labels`: one member for each label
  on an issue (`teamId`, `id` of the issue,
  `name`);
- a new call `issue.label`. Its input names the
  issue, the version it saw, a label `name`, and
  `on` (`true` puts it on, `false` takes it off).

Change your own files: the ops, the pages, your tests.

## Server journeys

S11. A member can put a label on an issue, and take
it off.

- A label change is a change of the issue. It
  names the version it saw, as a move does.
- It answers `{ kind: "labeled", version }`, with
  the issue's new version. A move, a rename and a
  label change count one version.
- An old version answers `stale`, as a move does.
- It answers as every change does: `gone`,
  `forbidden`, `archived`, in the same order.
- The other tabs of the team see the label come
  and go.

S5 changes: a read of a team's part by a non-member
is refused for each part: members, issues,
archived, labels.

## Page journeys

P8. Labels on the board.

- Each card has a text box `Label for ENG-1` and a
  button `Add label`. It puts that label on.
- Each label on a card is a button, its text the
  label, named `Remove bug from ENG-1`. It takes
  the label off.
- Above the lanes: a select `Show label`. Its
  options are `all`, then each label of the team,
  sorted. A label shows only the issues with it.
  `all` shows every issue.
- A label from another tab shows on the card and
  in the select.

## Rules your server keeps

R1 to R8 hold. These change:

- R2. The read hook refuses a non-member for each
  part: members, issues, archived, labels.
- R4. An answer that is not a success writes
  nothing: no label, no new version.

Judge your server again. Write `RULES.md` again.

## Done means

The same as before. Hidden tests check the journeys
of steps 1 to 5 that still hold.
