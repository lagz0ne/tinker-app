# Working on this app

This app runs on Tinker: `@tinkered/core`,
`@tinkered/react`, `@tinkered/bun`.
The rules for Tinker code ship inside those
packages as skills. A skill has the version of
the code you have installed.

<!-- intent-skills:start -->

## Skill Loading

Use the repository’s installed Intent. If it is unavailable, report the missing dependency instead of downloading a replacement.
Before editing files for a substantial task:

- Run `bunx --no-install --package @tanstack/intent intent list` from the workspace root to see available local skills.
- If a listed skill matches the task, run `bunx --no-install --package @tanstack/intent intent load <package>#<skill>` before changing files.
- Use the loaded `SKILL.md` guidance while making the change.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.

<!-- intent-skills:end -->

## After you edit: run the check

1. `bun run check:plain` runs `tinker check`.
   It runs four stages: types, rules, tests,
   then exits. An exit is one way out of an
   operation: each `kind` of its answer, a
   refusal, or a plain return. A test must reach
   each one.
   A finding is one line, then its fix:
   `<file>:<line> <rule id> <what is there>`.
   The last line says what to do next.
   Fix each finding, then run it again.
   Only `tinker check: OK` says the code is done.
2. `bun run check:style`: format and lint.
3. `bun run check`: types, tests, build.

No cast: no `as` but `as const`, no `!`, no `any`.
A `switch` on a call's `kind` has a case for
each kind, and no `default`.

A test scope lists `exits` first, so the check
sees what the test reached:
`exits({ file: process.env.TINKER_EXITS })` in a
server test, `exits({ store: localStorage })` in
a browser test.

An exception to a rule goes in `tinker.json`,
with its reason.
Do not add one to make a check pass.
