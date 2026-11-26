# Task, step 9: a bug report

You built the issue board in steps 1 to 8. Your
code is in this folder. `TASK-ck1.md` to
`TASK-ck8.md` are the tasks before this one. They
still hold.

You work in this folder only. Do not read files outside it.

## The report

A user wrote this:

> Ana here, from team WEB. Bo was a member and
> had two issues assigned. Bo moved to another
> project, so I made Bo a viewer: in "Add member"
> I typed `bo`, picked the role `viewer`, and
> pressed the button.
>
> Now it is wrong. Bo's two issues still say Bo
> works on them, and they are still in Bo's "My
> issues". Bo cannot change them: Bo is a viewer.
> The Assignee box of those cards does not show
> Bo, so it looks like nobody has them. Nobody
> picks them up.
>
> I expect: when a person becomes a viewer, the
> team's issues assigned to them go back to
> nobody. Bo's issues in other teams stay Bo's.

The rule from step 6 holds: an assignee is always
a `member` of the team. A viewer is never one.

## What to do

1. Find the cause in your code.
2. First write a test that shows the bug. Put it
   in a new file `tests/bug.test.ts`. Run it on
   your code as it is now: it must fail.
3. Then fix the code. The test passes now, and
   every test of yours still passes.

The scorer checks step 2: it runs your
`tests/bug.test.ts` on this folder as it was when
this step started. There, it must load and fail.
So it imports only files that exist now.

The given files stay given. Do not change them:
`src/issues/contract.ts`, `src/issues/sign-in.ts`,
`src/issues/index.ts`, `src/routes.tsx`, `cmds/**`.

## Server journeys

S16. A person made a viewer is no longer an
assignee.

- `team.add` with a person who is in the team sets
  their role. It answers `{ kind: "added" }`.
- When the role becomes `viewer`, each issue of
  that team assigned to them goes back to nobody.
- Each such issue is a change of the issue (S12,
  S14): one new version, and one event `assigned`
  by the caller.
- Nothing else changes: their issues in other
  teams, other people's issues.
- A role that stays `member`, a viewer added
  again, or a viewer made a `member`: no issue
  changes, no event.
- A `team.add` that answers `gone`, `forbidden` or
  `archived` takes nobody off an issue.
- The other tabs see it with no reload: the card,
  "My issues", the history.

## Rules your server keeps

R1 to R8 hold, as in step 8. Judge your server
again. Write `RULES.md` again.

## Done means

The same as before, and the scorer's check of
`tests/bug.test.ts` (step 2). Hidden tests check
the journeys of steps 1 to 9 that still hold.
