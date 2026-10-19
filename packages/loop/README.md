# @tinker/loop

Tools for a writer's loop: design, write, check, review, fix.
The writer calls each tool. This package has the `tinker-loop` command.
Run `vp exec tinker-loop check` before review.

## Check

```bash
vp exec tinker-loop check [--app <dir>] [--base <ref>]
```

The command reads `<app>/loop.json`:

```json
{
  "base": "next",
  "gates": [{ "name": "typecheck", "run": "npm run typecheck", "timeout": 600000 }]
}
```

It runs each gate in order, in the app folder.
It runs every gate, also after a red gate.
Each gate's output goes to `.loop/gates/<name>.log`.
Two gate names must not give the same log file name.
A gate stops after its `timeout` in milliseconds. The default is 20 minutes.
A stopped gate is killed with all of its child processes.
A red gate gives a `G1` finding with severity `important`.
Its summary is the first error line of the gate's output.

Then it greps the added lines of the change in the app folder.
The change starts where this branch left the base.
It ends at the working tree, as the gates see it.
Untracked files that git does not ignore count as added.
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

The base comes from `--base`, used as it is.
Without `--base`, the scan uses the `base` branch in `loop.json`.
If that branch tracks a remote, the scan uses that remote branch.
A local `next` is often old; `tinker-app/next` is not.
Next it tries the branch itself, then `<remote>/<base>` when the repo has one remote.
The run prints the base it used.
If git finds no base, the scan is skipped, and the run says why.
Then earlier scan findings stay as they are.

Exit code 1 means a gate is red. Grep hits never change the exit code.
Exit code 64 means a bad command line.
Exit code 78 means a bad `loop.json` or findings file.
Exit code 130 or 143 means Ctrl-C or SIGTERM stopped the run. A stopped run writes no findings.

## Findings

```bash
vp exec tinker-loop findings [--app <dir>] [--open]
```

The findings file is `<app>/.loop/findings.jsonl`.
It has one JSON object on each line. Each object has a string `id`.
The `.loop` folder ignores itself, so git never commits it.

```json
{"id":"3f9a2b1c4d5e","rule":"G1","severity":"important","file":"typecheck","line":null,"summary":"src/x.ts(3,1): error TS2322","trigger":"`npm run typecheck` exited with code 2; full output in .loop/gates/typecheck.log","fix":"Make `npm run typecheck` pass.","source":"check","round":2,"status":"open"}
```

The first eight fields are the tinker-review finding line.
The loop adds these fields:

- `source`: `check`, `judge`, or `review`.
- `round`: the run that last saw or changed the finding.
- `status`: `open`, `fixed`, or `answered`.
- `sha`: the HEAD commit when a `fixed` finding went away.
- `dirty`: `true` when that fix was only in the working tree.
- `reason`: why an `answered` finding stays.

The `id` is a hash of `source`, `rule`, `file`, and `summary`.
A `G1` id leaves out the summary: one red gate is one finding.
The line number is not part of the id.
Digits in the summary do not change the id, so timings and counts make no new finding.
So a new run updates a finding. It does not add a copy.

Each check run is a new round, one more than the highest round in the file.
A check finding that is gone becomes `fixed` at the current HEAD.
An `answered` finding that is gone becomes `fixed` too, and keeps its `reason`.
A `fixed` finding that comes back is `open` again.
Check never changes `judge` or `review` findings.

## Writing the file

Every tool that writes the file holds `.loop/findings.lock` around its read, merge, and write.
Use `updateFindings` from `@tinker/loop/findings`; it takes the lock for you.
The lock holds the owner's pid and time.
A lock whose pid is gone, or that is older than 30 seconds, is stale and is removed.
