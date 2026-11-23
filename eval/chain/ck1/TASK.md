# Task: build the issue board (server ops + pages)

You work in this folder only. Do not read files outside it.
Do not use git. Git is not scored.

The contract is given. Do not change these files:

- `src/issues/contract.ts`
- `src/issues/sign-in.ts`
- `src/issues/index.ts`
- `src/routes.tsx`, `cmds/**`

Change no other file that is already here (config,
`tinker.json`, the other features, their tests).
The scorer checks each one. You add files only.
One exception: you may add `graph.rules` to
`tinker.json`. Do not change its other keys.

Write two files, and your own tests for them:

- `src/issues/ops.server.ts` exports `issueOps`, `signedIn`, `membersOnly`.
- `src/issues/board.tsx` exports `IssuesHome`, `Board`, `Thread`.

The cmds already install them:

```ts
issues.board({ serve: true, onStart: [signedIn, membersOnly] }),
issues.api({ implement: issueOps, onStart: [signedIn] }),
```

Follow `AGENTS.md`. Load the Tinker skills first. Look at
`src/todo` for a feature that is already done.

`tinker.graph` is not here. Make it with `bunx tinker graph --write`.

## Server journeys

S1. A team is made once.

- `team.create` on a new key answers
  `{ kind: "created", teamId }`, with the key as the
  contract made it (upper case).
- The caller becomes its first member.
- Again on the same key answers
  `{ kind: "exists", teamId }`.
- `exists` changes nothing: a caller who is not in the
  team stays out of it.

S2. Issue numbers count up per team, with no gap: 1, 2, 3.
A second team starts at 1 again.

- `issue.create` answers `{ kind: "created", number }`.
- A new issue is in `backlog`, at version 1.

S3. A move on one tab shows on the other tab.

- `issue.move` names the version it saw.
- Same version: answers `{ kind: "moved", version: v + 1 }`.
- Any other version: answers
  `{ kind: "stale", version: <now> }` and changes nothing.
- A move writes the issue once.

S4. A comment lands in its own part, read by team and issue.

- Its `author` is the caller.

S5. Who may do what.

- A call or a read with no `who` in its meta is refused
  (`input.refuse(...)`), so the tab gets a `refused` fault.
- A signed-in caller who is not in the team gets
  `{ kind: "gone" }` on every call that names that team
  (`team.create` aside).
- A read of a team's part by a non-member is refused with
  payload `{ notMember: teamId }`; the tab's part is a fault.
  This holds for each part: members, issues, comments.
- A move or a comment that names an issue the team does
  not have: `gone`.
- A call that answers `gone` writes nothing.

S6. A person added while their tab is open sees the team
after "Try again" (an `invalidate` of the part).

S7. One move is one trace. Use these operation labels:

- `issues.signedIn` — the start hook on calls and reads.
- `issues.membersOnly` — the start hook on reads.
- `issues.inTeam` — the member check each call and
  each read runs, before the call reads an issue. It answers true or
  false; the call answers `gone`.
- `<address>.do` — the op behind each address,
  for example `issue.move.do`.

A trace holds these operations of yours and no other:

- a call: `issues.signedIn`, `issues.inTeam`, `<address>.do`;
- a read: `issues.signedIn`, `issues.membersOnly`,
  `issues.inTeam`.

So the read hook runs `issues.inTeam` for its check.

## Page journeys (React, real Chromium)

Roles and control names below are exact: a test finds
a control by its role and name, as a person does. The
words of a message are yours: a test looks for its role
(`status` or `alert`) and for what the page does, not
for the words.

P1. `/issues`: a form with input `Your name` and button
`Sign in`. When signed in, a form with input `Team key`
and button `Open team`. Opening calls `team.create` with
the key as typed, then goes to `/issues/<teamId>`, the key
in the answer. So a new key makes the team, and a key that
exists opens it: `eng` opens `/issues/ENG`. The page does
not change the key itself.

P2. `/issues/<team>`: a heading with the team key.

- Form: input `New issue`, button `Add issue`.
- Form: input `Add member`, button `Add member`.
- Four regions: `<section aria-label="backlog">`, and so
  for todo, doing, done. Each card is in its state's
  region, and in no other. A region lists its cards by
  number.
- Each card: a link with text `ENG-1` to
  `/issues/ENG/<id>`, then the title.
- Each card: a select `State of ENG-1`; a change moves it.
- A stale move shows a status, and the card stays.
- A move or an add (issue, member, comment) that
  answers `gone` shows a status.
- Each form and each card shows its own message. A
  second `gone` adds or changes one.
- A move on another tab shows here with no reload.

P3. `/issues/<team>/<id>`: an `aside` labelled `Comments`.

- Each comment as `bo: Seen on Safari`.
- Input `Comment`, button `Comment`.
- The thread reads its own part, so it shows its own
  loading status and read faults (P4) inside the aside.

P4. Faults, each a message in `role="alert"` or
`role="status"`, in your words.
On the board page these sit inside its `<main>`:

- A page state shows one message. Keep no other
  `role="status"` or `role="alert"` element on the page.
- The board draws from its read alone. When the read is
  ready, the forms show, also when this tab has no name
  and the team has no member.

- Board not read yet: a status in place of the board
  (no form shows).
- Read refused, not in team: an alert and a button
  `Try again`.
- Read refused, not signed in: an alert in place of
  the board (no form shows).
- Read lost its link (server gone): a status in place
  of the board (no form shows), no `Try again` button.
- Call did not leave: a status.
- Call left, no answer: a status.
- Server lacks the address: an alert.
- Any other fault: an alert that holds the first 8
  characters of the fault's trace id.

## Rules your server keeps

A judge reads your server code against these rules.
Each rule is OK, or a violation at a file and line.

- R1. Each call that names a team runs `issues.inTeam`
  first. `team.create` is the one exception. It reads
  only `members`, never an issue.
- R2. The read hook runs `issues.inTeam` and refuses a
  non-member for each part: members, issues, comments.
- R3. The start hooks and `issues.inTeam` write nothing.
- R4. An answer of `gone`, `stale` or `exists` writes
  nothing.
- R5. Issue numbers count within one team.
- R6. A move is `stale` for any version other than the
  one stored now.
- R7. An issue is found by team and id. Another team's
  issue is `gone`.
- R8. The member check runs before any issue is read.
- R9. A comment's author is the caller, never a field
  of the input.

Before you finish, judge your own server against each
rule, the way the judge will. For each rule, write one
line in `RULES.md`: `R1 OK`, or `R1 VIOLATION
src/issues/ops.server.ts:<line> <why>`. Fix each
violation, then judge again.

## Done means

- `bun run check:plain` prints `tinker check: OK`.
- `bun run check:style` passes.
- `RULES.md` says OK for each rule.

`tinker check` runs your tests. It fails for each exit
of an operation that no test of yours reaches: each
answer `kind`, a refusal, a plain return. So write a
test for each one. `AGENTS.md` shows the capsule that a
test scope lists.

Hidden tests check the journeys above too.
