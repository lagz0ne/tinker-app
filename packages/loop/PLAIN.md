# Plain functions

This list is checked against src, cmds, and tinker.
Callers include direct calls and typed callback registrations.
Repeated calls by one caller count once; self-calls do not count.
Tests and generated files do not count.

- **src/report.ts#findingLine**
  - `f`: `z.infer<typeof finding>`. From the findings file; why: the row to show.
  - Callers:
    - `src/operations/findings.ts#findings.run`
    - `src/operations/status.ts#status.run`
    - `src/report.ts#summary`

- **src/report.ts#summary**
  - `findings`: `z.infer<typeof finding>[]`. From a merge of the findings file; why: the rows to count.
  - Callers:
    - `src/operations/check.ts#check.run`
    - `src/operations/review.ts#review.run`

- **src/report.ts#shortSha**
  - `sha`: `string | null`. From git or the last check; why: the commit to show.
  - Callers:
    - `src/operations/status.ts#checkReasons.run`
    - `src/operations/status.ts#status.run`

- **src/report.ts#count**
  - `n`: `number`. From a count of rows; why: the number to show.
  - `noun`: `string`. From the caller's text; why: what is counted.
  - Callers:
    - `src/operations/status.ts#checkReasons.run`
    - `src/operations/status.ts#status.run`
