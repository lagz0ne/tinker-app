# Ablation overlay: what changes

`overlay.sh` edits the writer's tree only, never a kit
file. Arm A (full kit) uses no overlay. Arms B and C
are for the train chain (`eval/chain`) only, never the
holdout. Each edit matches its text and fails when the
text is not there.

## B and C (`overlay.sh <arm> start`, after `bun install`)

Deleted from `node_modules`:

- `@tinkered/core/skills/` (6 `SKILL.md`)
- `@tinkered/react/skills/react/SKILL.md`
- `@tinkered/cli/README.md`

`AGENTS.md`: the three lines "The rules for Tinker
code ship inside those packages as skills…", and the
whole `<!-- intent-skills:start -->` … `end -->`
block (the "Skill Loading" section).

`README.md`: the line `more: tinker skill load
@tinkered/react#react`, and the "For agents" section
(its text and its `bunx intent` block).

`TASK.md` of ck1 (`overlay.sh <arm> step 1`): "Load
the Tinker skills first." goes.

## C only

- `package.json`: the `check:plain` script goes.
- `node_modules/.bin/tinker`: a stub that prints
  "tinker: not available in this run" and exits 1.
- `AGENTS.md`: the section "After you edit: run the
  check" (to the end of the file) becomes one line:
  "After you edit: `bun run check:style`, then `bun
run check`." `bun run check` is typecheck, test,
  build; it never runs `tinker check`.
- `TASK.md` of ck1: the line "`tinker.graph` is not
  here. Make it with `bunx tinker graph --write`.",
  the Done line "`bun run check:plain` prints `tinker
check: OK`.", and the paragraph "`tinker check` runs
  your tests. … test scope lists."
- `TASK.md` of ck2: "`tinker check: OK`," goes from
  its Done line.
- `TASK.md` of ck3 to ck8: no mention of the check or
  a skill (the step stops if one shows up).

## Not changed

- C keeps `check:style`: its lint has the `tinker/*`
  lint rules (from `vite.config.ts`).
- C keeps the README section that tells what `tinker
check` does (the rules list). The lead's list did
  not name it.

## Hashes on a start tree from golden ck1 (0.34.10)

| arm | file            | before             | after              |
| --- | --------------- | ------------------ | ------------------ |
| B   | `AGENTS.md`     | `4aaf79ee21f21439` | `e194b66f6e798d06` |
| B   | `README.md`     | `afc11f103dcbd9d1` | `f15221dfc042cbff` |
| B   | `package.json`  | `45ebed93349b0fab` | same               |
| B   | `TASK.md` (ck1) | `d60dd1b5a63e7deb` | `3a812e7a5ac29d43` |
| C   | `AGENTS.md`     | `4aaf79ee21f21439` | `a243d4336e3fc266` |
| C   | `README.md`     | `afc11f103dcbd9d1` | `f15221dfc042cbff` |
| C   | `package.json`  | `45ebed93349b0fab` | `af8881501612d946` |
| C   | `TASK.md` (ck1) | `d60dd1b5a63e7deb` | `a9dd4a86ea0cd368` |

(sha256, first 16 hex.)

## Guard (`overlay.sh <arm> guard`, after each writer session)

Exit 1 when a `SKILL.md` or `@tinkered/cli/README.md`
is back in `node_modules`, or (C) the real `tinker`
bin is back. The runner voids that chain.
