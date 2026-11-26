# CUJ chain (SlopCodeBench model)

Duke picked A, 2026-11-21: golden is a chain of
steps on the writer's own tree, strict.

Precedent: SlopCodeBench (arXiv 2603.24755).
The writer extends its own code. Each step has a
fresh session; only the folder stays. All earlier
tests run again.

## Steps

- ck1: today's task (kit 9.1 TASK.md, now in
  `ck1/TASK.md`; golden = tinker-app main 436a33d).
- ck2: `issue.rename`. Golden ebe4c87.
- ck3: `team.archive`; comments go. Golden 3377e87.
- ck4: a viewer role; every change by a viewer
  answers `forbidden`. Golden 1264f11: one edit in
  `issues.canWrite`. A writer that copied the
  check into each op must find every copy.
- ck5: labels; a label change is a versioned
  change of the issue. Golden e071c64.
- ck6: assign; `/issues/mine` reads
  `members.where({ userId })`, so the read hook
  must let that part go to that user alone.
  Golden 0ffe998.
- ck7: history; every change of an issue leaves
  one event. The TASK states the rule, not each
  call. Golden 61242b0: one op `issues.record`,
  and a graph rule in `tinker.json`.
- ck8: delete a team; every part of steps 1 to 7
  goes. Golden 91eda9f.
- ck9 (v2): a bug report in plain words; the writer
  writes a red test first. Golden bacb51b.
- ck10 (v2): a welcome mail through an outbox.
  Golden 32ac169. See "Chain v2" below.

Each `ckN/` has:

- `TASK.md`: the step's task (a delta);
- `given/`: files copied over the tree, read-only;
- `hidden/`: the tests at that step (old journeys
  edited only where the spec changed);
- `new-tests.txt`: the test names new at that step.

## Run one chain

1. ck1 as today. Keep the tree.
2. Rename `TASK.md` to `TASK-ck1.md`.
3. Copy `ck2/given/*` over `src/issues/`
   (`routes.tsx` to `src/`), put `ck2/TASK.md`.
4. Commit the tree (the writer sees a clean start).
5. Start a NEW writer session in the same tree.
6. Score ck2. Then the same for ck3.

A step that is not strict ends the chain. The later
steps score 0 (as SlopCodeBench).

## Score of a step

Strict = all of these:

- hidden tests of that step: all pass;
- `tinker check: OK`, `check:style`, typecheck;
- given files byte-equal;
- the judge: each R rule OK.

Iso = the tests in `new-tests.txt` pass.
Iso without strict means new work broke old work.

## Facts (printed, never a gate)

- `node facts/erosion.cjs <ts files>`: erosion,
  clone share, max CC, functions over CC 10.
- `tinker.graph` diff from the step before.
- Ops that two or more call ops call (reuse).
- ck3: what is left of comments
  (`grep -ri comment src/issues`).

Golden facts: erosion 0.00 at each step;
ck2 move and rename both call `issues.atVersion`;
ck3 every change calls `issues.canWrite`;
ck4 the role check is in `issues.canWrite` alone.

## Chain golden

A model is golden on the chain when 5 of 5 runs are
strict at ck1, ck2, ck3 and ck4.

## Skill trial (run 13)

`skill/operation-SKILL.md` is the installed
operation skill plus one section: read
`tinker.graph` before you write a check, and call
the operation that makes it.

- Base: the old skill. Run ck4 on each tree that
  ended run 12 strict at ck3.
- New: copy the file over
  `node_modules/@tinkered/core/skills/core/operation/SKILL.md`
  before ck1, then run the chain to ck4.

Facts per step: strict, and the cell readers from
`tinker.graph` (each cell, and the ops that read
it directly).

## Graph rules (run 15)

`@tinkered/*` 0.34.5 checks `graph.rules` in
`tinker.json` (ADR 0167). Its operation skill says
when to write one.

- `ck1/TASK.md`: the writer may add `graph.rules`
  to `tinker.json`, and must not change its other
  keys. The TASK does not say what to write.
- The scorer counts `tinker.json` as unchanged when
  its only change is a `graph` key.
- `ck4/hidden/issue-board.test.tsx`: the member
  form's select is found by role and name
  (`combobox`, `Role`, exact). By label text, a
  `<label>` that wraps the select reads as
  "Rolememberviewer" and matches nothing.

## Start tree fix (run 16)

`start/tests/drizzle.test.ts` is main 9f51755's
test, byte-equal. Its second PGlite scope starts in
a `beforeAll` (30 s), not in the 5 s test. The old
test timed out on a busy box, so `tinker check`
failed with no writer fault. The runner retried it.

The golden commits (436a33d, ebe4c87, 3377e87,
1264f11) keep the old test. Before a run:

1. Copy the file over `tests/drizzle.test.ts` in
   each golden tree ck1-ck4.
2. Make the start tree from golden ck1 as before.
   It gets the file, and its manifest hashes it.
3. Make each golden manifest the same way, after
   the copy.

The file is a given file: a writer must not change
it. The runner needs no drizzle retry rule.

Checked on 0.34.5: golden ck1-ck4 with the file
are strict (22/22, 25/25, 25/25, 28/28).

## Harder chain with grow (run 16)

Duke, 2026-11-23: "harder chain with grow". Steps
5 to 8 extend the writer's own board. Each one
cuts across code of the steps before:

- ck5 and ck6 add a change that must take the
  shared checks (gone, forbidden, archived, stale).
- ck6 changes the read hook.
- ck7 states a rule over every change of an
  issue. A missed place fails a hidden test.
- ck8 must find every part, also those of ck5 to
  ck7.

Hidden test edits (spec changes only):

- S5 lists each part of a team: labels at ck5,
  events at ck7.
- ck7 trace test: a move writes two cells, so it
  picks the send to `issues`.

A model is golden on the long chain when 5 of 5
runs are strict at ck1 to ck8.

ck8 needs `@tinkered/*` 0.34.7: its Core fix
(card `core/member-ask-fault-hidden`) makes a
refused re-ask of one member a fault of the part.
Before it, the other tab's part stayed `ready`.

Golden ck8 on 0.34.7 also lets a user read their
own `members` rows by their whole key. A lost row
is asked again by its whole key, `{ teamId,
userId }`, so a hook that checks the team first
refuses it, and "my teams" keeps a deleted team.

Run 16: make every golden tree ck1 to ck8 on
0.34.7 (`bun update --latest @tinkered/*`), with
the start drizzle test, as run 15 did.

## Run 16 result and kit fixes

Run 16 (2026-11-24, 0.34.7): 0 of 15 chains strict
to ck8. Report on the box: `/home/paseo/cuj16/REPORT.md`.

Fixes after run 16:

- ck1 now holds `given/` and `hidden/`, from golden
  436a33d. ck1 has no `new-tests.txt`: at step 1
  every hidden test is new.
- ck8 delete test waits for `Team key`, not
  `Your name`. A signed-in home page may hide the
  name form (TASK P1).
- TASK ck5-ck8 name the step 1 given files again.
- Golden ck8 hook: a user reads their own member
  rows; another user's whole-key row takes the team
  check. Before, golden refused it, and its members
  part went to `fault`; the page hid that.
- ck6-ck8 hidden P9: a member added alone shows in
  the Assignee options. Red on the old golden ck8.
- TASK ck6, ck7 R2 say the same in words.

Run 17: canary first. Golden ck1-ck8 must be
strict with these hidden tests.

Fix during run 17 (applies from run 18):

- The ask-trace check on the server took an exact
  list. A writer's own op in the read hook (a
  shared check) failed it, though the TASK allows
  it. It now uses `arrayContaining`, as the call
  check beside it does. All hidden copies ck1-ck8.
- The two call-fault page tests ran on a bare
  reads server with no member rows. A page that
  checks the caller is in the team hid the board.
  Real use always has the row (the hook refuses a
  non-member). The tests now add ana's row first.

Fixes after run 17 (9 of 15 strict to ck8):

- Call-fault page tests: the page tab signs in as
  ana, and the missing-address test's server holds
  ana's member row (completes 8273a0f).
- `tests/todo.test.ts` stress test: 60 s limit,
  15 s waits. It tests for a hang, not for speed:
  about 3 s idle, over 20 s at load 33. It ended 2
  chains in run 17 and hit run 16 twice.

## Golden trees on 0.34.10 (run 19)

`@tinkered/*` 0.34.10 changes `tinker.graph`: each
op line gets `faults{}` and `uses{}` (empty in every
golden tree), and each page component gets a line
`view <file>#<Component> reads{} runs{}`. A graph
written by 0.34.8 fails `tinker check` on 0.34.10,
so each golden graph is written again.

- `ckN/golden/` (ck1 to ck7): copy these files over
  golden tree ckN (`package.json`, `bun.lock`,
  `tinker.graph`, and the start tests). Each file is
  what `bun add @tinkered/*@^0.34.10` and
  `bunx tinker graph --write` give on that commit.
- ck8 is the branch tip: its `package.json`,
  `bun.lock` and `tinker.graph` are 0.34.10 here.

No op line changed apart from the two new fields.
Golden ck1 to ck8 are strict on 0.34.10.

## Chain v2: ck9 and ck10 (2026-11-26)

Two steps on top of golden ck8, in the same format.
Duke's goal: find where Tinker breaks.

- ck9: a bug report on the writer's own code.
  Golden bacb51b.
- ck10: a welcome mail through an outbox. Tinker
  has no queue or outbox part; the step measures if
  a writer can build one from Core parts.

### ck9: the bug report

The TASK is a user's report in plain words. It
names no file. The bug: a member made a viewer
stays the assignee of their issues. That breaks
S12 (an assignee is always a `member`).

Why this bug: golden ck8 and all 10 run-20 trees
have it. Each one fails the same 2 of 47 ck9 hidden
tests, and passes the other 45. So the step is
fair on any tree. Nothing is planted.

Golden fix: `team.add` sets the role; a new viewer
is taken off each issue of that team through
`issues.record` (one version, one `assigned`
event by the caller).

Hidden: ck8's 43 tests + 4 root-cause tests (3
server, 1 page) = 47.

**Red-first rule.** The writer writes
`tests/bug.test.ts` first. `ck9/red-first.sh
<before-tree> <after-tree> <out>` checks it:

- red: on a copy of the tree as the step started,
  the file loads and at least one test fails;
- green: on the tree at the end, every test of the
  file passes.

A file that does not load on the old tree is not
red. Strict at ck9 = strict as before, and
`red-first.sh` OK.

**Judge.** `judge/` holds the run-20 judge with
steps 9 and 10. Both judge as step 8. One change:
at ck9+, F4 lists `team.add.do` as a writer of
`issues.list` and `issues.events`.

### Adversarial probes (ck9 search)

`probes/adv.test.ts`: 20 server probes (error
paths, team isolation, validation, state, side
effects). Not a hidden test. `probes/run.sh <tree>
<out.json>` runs it in a tree with `node_modules`.
A red probe is a finding, not a score. Run on golden ck8 and the 10
run-20 trees (ck8 state):

| probe | what                                | golden         | ds 1-5        | muse 1-5        |
| ----- | ----------------------------------- | -------------- | ------------- | --------------- |
| A04   | a part with no `teamId` in its key  | ok             | ok            | **leak in 1-4** |
| A06   | a label put on twice                | +1 version     | same          | same            |
| A07   | a label taken off that is not on    | +1 version     | same          | same            |
| A08   | a move to the state it is in        | +1 version     | same          | same            |
| A09   | a member made a viewer              | stays assignee | same          | same            |
| A10   | the last member makes self a viewer | no member left | same, ds-4 ok | same            |
| A20   | `team.add` changes a member's role  | yes            | ds-4: never   | yes             |

The other 14 probes pass on all 11 trees:
parallel creates, a race of two changes, another
team's issue, parts by team and issue, a delete
next to a key that starts the same, check order,
stale and `notAssignable` write nothing, events
keep `by`, a big delete, a team made again.

- A04 (writer fault, kit gap): Muse 1-4's read hook
  lets a part through when its key has no `teamId`
  and no `userId`. An outsider reads
  `labels.where({ name: "bug" })` and gets every
  team's labels, with issue ids. Then
  `issues.where({ id })` gives the whole issue. No
  hidden test reads such a part, so all four were
  strict. Lead, 2026-11-26: not in ck9; it is a
  Tinker gap, fixed by design elsewhere. A Tinker gap too: the read hook gets any
  part, and no skill says "refuse what you do not
  know".
- A06-A08 (spec gap): the TASKs never say if a
  change that changes nothing is a change. All 11
  trees count it.
- A09 (shared fault): ck9's bug.
- A10, A20 (spec gap): no TASK says what `team.add`
  does to a person already in the team. 9 trees set
  the role; n-ds-4 keeps the first role.

### ck10: the outbox

The TASK: `team.add` of a new person puts one
welcome mail out. The call answers at once, also
when mail is down or hangs. `drainMail` sends it
later; each add gives one mail in the end.

Given (copy over the tree; keep the tree's
`graph` key in `tinker.json`):

- `src/issues/mail.ts`: the tag `mailer`, with
  `send(to, subject, body)` (ADR 0113). No default.
- `cmds/server.ts`: binds a stand-in mailer (it
  writes each mail to stdout), and runs `drainMail`
  each second at the root.
- `tinker.json`: one `plain` exception, for that
  stand-in mailer.

Make the ck10 manifest from ck9's: put in the hash
of the given `cmds/server.ts`. `mail.ts` is new: the
scorer checks it against the kit. The scorer takes
`ck10/given/tinker.json` as the base of the
`graph`-only rule.

Golden (`src/issues/outbox.server.ts`, about 70
lines): a keyed cell `issues.outbox` written at the
root (`atScope`), an op `issues.post`, and
`drainMail`. A drain holds each mail it takes
(`until` on the clock), so a second drain skips it.
A send that throws, or that does not answer in 5 s
on the scope clock, puts the mail back. Core is not
changed.

Hidden: ck9's 47 + 4 server + 1 page = 52. The
fakes throw once, never answer (the test clock
ends the wait), and two drains run at once.

Why the cmd runs the drain: when a call ends, Core
aborts the `ctx.signal` of each run the call
started, and waits for them to end before it
answers. So a drain started inside `team.add`
either gives up at once (it listens to the
signal), or holds the answer until the send ends
(forever when mail hangs). No call can start work
that outlives it. The root must own the drain.

### Seeds

`seeds/prove.sh <golden-tree> <step> <seed.patch>`
copies the tree, applies the seed, runs the step's
hidden tests.

- `ck9-unassign-every-team.patch`: takes the viewer
  off their issues in every team. Caught: 2 of 47.
- `ck10-drain-takes-held-mail.patch`: a drain takes
  mail that another drain holds. Caught: 2 of 52.

### Tinker gaps seen while building v2

Each is a fact for the lead, not a fix. Core is not
changed.

1. No owner for work that outlives a call (the
   ck10 probe). Repro on golden ck10: in
   `team.add.do`, depend on `drainMail` and add
   `void drain.run();` after the post. Bind a mailer
   whose `send` never answers, on a test clock. The
   `team.add` call never answers. With
   `clock.sleep(ms, signal)` in the drain instead,
   the call answers, but the drain gives up at once:
   its signal aborts when the call ends.
2. A tag that holds an adapter fails
   `tinker/plain`. ADR 0113 says outside effects
   come in by tag. But a tag value with a method,
   as a default (`tag({ default: { send: async ()
=> undefined } })`) or bound in a cmd
   (`mailer({ send: async () => ... })`), is "a
   plain function". ck10 needs a `tinker.json`
   exception for the cmd's stand-in mailer.
3. A read hook gets any part, also one with no team
   in its key (`labels.where({ name })`). No skill
   says to refuse what the hook does not know. 4 of
   5 Muse trees let it through (A04).

### Proof (2026-11-26, 0.34.10)

From clean copies of each commit:

- Golden ck9 (bacb51b): strict, 47/47, iso 4/4,
  judge 8/8 OK. `red-first.sh` (before = 4f662ba):
  red 1 of 1, then green.
- Golden ck10 (32ac169): strict, 52/52, iso 5/5,
  judge 8/8 OK.
- Seeds: ck9 caught (45/47), ck10 caught (50/52).
- ck9 hidden on golden ck8 and on each of the 10
  run-20 trees: 45/47, the same 2 tests red.

## ck10b: the welcome mail, behaviour only (2026-11-26)

Lead, after the v2 baseline (28 of 28 pass): from
now on a v2 TASK states behaviour only. It never
gives the design: no who-runs-what, no op names, no
cmd that does the work.

ck10b replaces ck10 in the chain: ck9, then ck10b,
then ck11. ck10 stays as the design-given variant.

The TASK: `team.add` of a new person gives one
welcome mail. The call answers at once, also when
mail is down or never answers. In the end each add
gives exactly one mail, also after failures and
with slow sends. Limits it states: the mail
arrives within 2 s with mail up; a send not
answered in 10 s has failed; once mail is back,
the mail arrives within 1 minute. The server cmd
writes each mail to stdout (`mail to bo: Welcome
to ENG`).

Given: `src/issues/mail.ts` only (the `mailer` tag,
no default). `cmds/server.ts` is the writer's now.
In `tinker.json` the writer may add `graph.rules`,
and a `plain` entry for a file of its own.

**The one seam.** The hidden tests name no op. They
need the server's own parts, so the TASK names one
export: `serverParts` in `src/issues/ops.server.ts`,
the capsules the board needs on the server besides
`issues.board` and `issues.api` (may be empty). The
tests install it and bind a fake mailer and a test
clock. They add people, move the clock, and count
what the fake got. The cmd test runs the real
`cmds/server.ts` and reads its stdout.

Golden: `team.add` posts to the outbox cell and
answers. A capsule `mailRelay` (in `serverParts`)
starts a root worker in its start hook, with the
root's closing signal: each second it drains the
outbox. The cmd binds a stand-in mailer and installs
`serverParts`; `tinker.json` gets the `plain` entry
for that mailer.

Hidden: ck9's 47 + 5 server + 1 page = 53.

Scorer (`score-step.sh` step `10b`): given files
are looked up in `ck10b`, then 9 to 1 (not ck10).
The manifest is ck9's without `cmds/server.ts`, with
`mail.ts`. `tinker.json` may differ from the start
in `graph` and in `plain` entries for `src/` files
or `cmds/server.ts`. The judge runs as step 10.

Seed `ck10b-drain-in-the-call.patch`: `team.add`
also starts a drain inside the call (gap 1). The
call then holds its answer while mail hangs.
Caught: 30 of 53 fail.
