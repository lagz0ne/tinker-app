# CUJ chain (SlopCodeBench model)

Duke picked A, 2026-11-21: golden is a chain of
steps on the writer's own tree, strict.

Precedent: SlopCodeBench (arXiv 2603.24755).
The writer extends its own code. Each step has a
fresh session; only the folder stays. All earlier
tests run again.

## Steps

- ck1: today's task (kit 9.1 TASK.md, golden =
  tinker-app main 436a33d).
- ck2: `issue.rename`. Golden ebe4c87.
- ck3: `team.archive`; comments go. Golden 3377e87.
- ck4: a viewer role; every change by a viewer
  answers `forbidden`. Golden 1264f11: one edit in
  `issues.canWrite`. A writer that copied the
  check into each op must find every copy.

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
