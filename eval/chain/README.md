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
