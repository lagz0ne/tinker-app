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

## After you edit: run the checks

1. `bun run check:plain` runs `tinker-analyze`.
   A finding is one line:
   `<file>:<line> <rule id> <what is there>`.
   After the findings, each broken rule names
   its skill: `read: @tinkered/core#core/operation`.
   Load that skill, fix the code, run it again.
2. `bun run check:style`: format and lint.
3. `bun run check`: types, tests, build.

An exception to a rule goes in
`tinker-analyze.json`, with its reason.
Do not add one to make a check pass.
