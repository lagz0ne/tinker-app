# Task, step 2: rename an issue

You built the issue board in step 1. Your code is in
this folder. `TASK-ck1.md` is the task of step 1. All
of it still holds, so all of its journeys are tested
again.

You work in this folder only. Do not read files outside it.

## What is new

The contract changed. `src/issues/contract.ts` is
given again, with one new call: `issue.rename`. Do not
change that file, or the other given files of step 1.

Change your own files: the ops, the pages, your tests.

## Server journeys

S8. A rename names the version it saw, as a move does.

- Same version: answers
  `{ kind: "renamed", version: v + 1 }`, and the
  issue has the new title.
- Any other version: answers
  `{ kind: "stale", version: <now> }` and changes
  nothing.
- A move and a rename count one version. So a
  rename from version 2 after a move to version 3 is
  stale.
- A caller who is not in the team gets `gone`. So does
  an issue the team does not have.
- A rename shows on the other tab with no reload.

S7 changes a little. A trace holds `issues.signedIn`,
`issues.inTeam` and `<address>.do`. It may also hold
ops of your own that a call runs.

## Page journeys

P5. Each card has a form to rename it.

- Input `Title of ENG-1`. It shows the title now.
- Button `Rename`.
- A stale or `gone` rename shows a status, as a move
  does (P2).

## Rules your server keeps

R1 to R9 of step 1 hold. Two change:

- R4. An answer of `gone`, `stale` or `exists` writes
  nothing. (A rename too.)
- R6. A move or a rename is `stale` for any version
  other than the one stored now.

Judge your server again against each rule. Write
`RULES.md` again, one line per rule.

## Done means

The same as step 1: `tinker check: OK`,
`check:style`, `bun run check`, and `RULES.md` all OK.
Hidden tests check the journeys of step 1 and step 2.
