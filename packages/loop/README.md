# @tinker/loop

Tools for a writer's loop: design, write, check, review, fix.
The writer calls each tool. This package has the `tinker-loop` command.

## Check

```bash
vp exec tinker-loop check [--app <dir>] [--base <ref>]
```

The command reads `<app>/loop.json`:

```json
{
  "base": "next",
  "gates": [{ "name": "typecheck", "run": "npm run typecheck" }]
}
```

It runs each gate in order, in the app folder.
It runs every gate, also after a red gate.
Each gate's output goes to `.loop/gates/<name>.log`.
A red gate gives a `G1` finding with severity `important`.
Its summary is the first error line of the gate's output.

Then it greps the added lines of `git diff <base>...HEAD`.
The diff covers only the app folder.
`--base` replaces the `base` in `loop.json`.
Each hit gives a finding with severity `question`.
A hit points at a line to read. It is not a verdict.

| Grep                                          | Rule |
| --------------------------------------------- | ---- |
| `process.env`, `process.argv`, `process.exit` | B1   |
| `Date.now`, `Math.random`, `randomUUID`       | B3   |
| `class X`, `setInterval`                      | O1   |
| `fetch(`, `node:net`, `node:http`             | H3   |
| `as unknown as`                               | H2   |
| `.skip(`                                      | H5   |

Exit code 1 means a gate is red. Grep hits never change the exit code.
Exit code 64 means a bad command line.
Exit code 78 means a bad `loop.json` or findings file.

## Findings

```bash
vp exec tinker-loop findings [--app <dir>] [--open]
```

The findings file is `<app>/.loop/findings.jsonl`.
It has one JSON object on each line.
The `.loop` folder ignores itself, so git never commits it.

```json
{"id":"3f9a2b1c4d5e","rule":"G1","severity":"important","file":"typecheck","line":null,"summary":"src/x.ts(3,1): error TS2322","trigger":"`npm run typecheck` exited with code 2; full output in .loop/gates/typecheck.log","fix":"Make `npm run typecheck` pass.","source":"check","round":2,"status":"open"}
```

The first eight fields are the tinker-review finding line.
The loop adds these fields:

- `source`: `check`, `judge`, or `review`.
- `round`: the run that last saw or changed the finding.
- `status`: `open`, `fixed`, or `answered`.
- `sha`: the commit where a `fixed` finding went away.
- `reason`: why an `answered` finding stays.

The `id` is a hash of `source`, `rule`, `file`, and `summary`.
The line number is not part of the id.
Digits in the summary do not change the id.
So a new run updates a finding. It does not add a copy.

Each check run is a new round.
A check finding that is gone becomes `fixed` at the current HEAD.
A `fixed` finding that comes back is `open` again.
An `answered` finding keeps its `reason`.
Check never changes `judge` or `review` findings.
