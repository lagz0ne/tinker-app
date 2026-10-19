# @tinker/loop

Tools for a writer's loop: design, write, check, review, fix.
The writer calls each tool.
This package has the `tinker-loop` command.
Run `vp exec tinker-loop check` before review.
Each command takes only its own flags.
A flag that a command does not take exits 64 and names the flag.

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
A gate stops after its `timeout` in milliseconds.
The default `timeout` is 20 minutes.
The longest `timeout` is 2147483647 ms, about 24 days.
A stopped gate's process group gets SIGTERM.
SIGKILL follows 5 seconds later.
A red gate gives a `G1` finding with severity `important`.
Its summary is the first error line of the gate's output.

Then it greps the added lines of the change in the app folder.
The change starts where this branch left the base.
It ends at the working tree, as the gates see it.
Untracked files that git does not ignore count as added.
Untracked files and the dirty state are read before the gates run.
So files that the gates write are not part of the change.
Each hit gives a finding with severity `question`.
A hit points at a line to read.
A hit is not a verdict.

| Grep                                          | Rule |
| --------------------------------------------- | ---- |
| `process.env`, `process.argv`, `process.exit` | B1   |
| `Date.now`, `Math.random`, `randomUUID`       | B3   |
| `class X`, `setInterval`                      | O1   |
| `fetch(`, `node:net`, `node:http`             | H3   |
| `as unknown as`                               | H2   |
| `.skip(`                                      | H5   |

`--base` gives the base, used as it is.
Without `--base`, the scan uses the `base` branch in `loop.json`.
If that branch tracks a remote, the scan uses that remote branch.
A local `next` is often old; `tinker-app/next` is not.
Next it tries the branch itself.
Then it tries `<remote>/<base>` when the repo has one remote.
The run prints the base it used.
If git finds no base, the scan is skipped.
The run says why it skipped the scan.
Then earlier scan findings stay as they are.

Exit code 1 means a gate is red.
Grep hits never change the exit code.
Exit code 64 means a bad command line.
Exit code 78 means a bad `loop.json` or findings file.
Exit code 129 means SIGHUP stopped the run.
Exit code 130 means Ctrl-C stopped the run.
Exit code 143 means SIGTERM stopped the run.
A stop before the write leaves the findings file as it was.

## Findings

```bash
vp exec tinker-loop findings [--app <dir>] [--open] [--rules]
```

`--open` shows only open findings.
`--rules` adds each finding's rule text from the app's own Start.

The findings file is `<app>/.loop/findings.jsonl`.
It has one JSON object on each line.
Each object has a string `id`.
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
- `seenSha`: the HEAD commit when check last saw the finding.
- `reason`: why an `answered` finding stays.

The `id` is a hash of `source`, `rule`, `file`, and `summary`.
A `G1` id leaves out the summary: one red gate is one finding.
The line number is not part of the id.
Digits in the summary do not change the id.
So timings and counts make no new finding.
So a new run updates a finding instead of adding a copy.

Each check run is a new round.
The new round is one more than the highest round in the file.
A check finding that is gone becomes `fixed` at the current HEAD.
An `answered` finding that is gone becomes `fixed` too.
It keeps its `reason`.
A `fixed` finding that comes back is `open` again.
Check never changes `judge` or `review` findings.

Each check that runs to the end saves `.loop/last-check.json`.
It holds the round, the HEAD commit, and each gate's result.
`status` reads it.

## Answer

```bash
vp exec tinker-loop answer <ID> --fixed [--sha <sha>] [--app <dir>]
vp exec tinker-loop answer <ID> --reason "<text>" [--app <dir>]
```

`answer` takes one finding ID.
It takes `--fixed` or `--reason`, not both.
`--fixed` marks the finding `fixed` at a commit.
`--sha` names that commit; the default is HEAD.
The commit must be in HEAD's history.
The commit must come after the finding's `seenSha`.
So commit the fix first, then answer.
A finding with no `seenSha` needs only a commit in HEAD's history.
`--reason` marks the finding `answered` with that reason.
An empty `--reason` exits 64.
An unknown ID exits 64.
A refused answer exits 64 and says why.
`answer` writes under the findings lock, with `updateFindings`.
A refused answer writes nothing.
Answered and fixed findings stay in the file.
A later check that finds a `fixed` finding again opens it again.
A later check that finds an `answered` finding again keeps it `answered`.

## Status

```bash
vp exec tinker-loop status [--app <dir>]
```

`status` applies the stop rule.
Done means three things.
The last check ran at the current HEAD.
Every gate was green in that check.
No `important` finding is `open`.
`status` prints one line for each open important finding.
Then it prints the verdict.
Exit code 0 means done.
Exit code 1 means not done.
The verdict lists each reason.
Exit code 2 means a person must check the work.
That is when review ran in 3 or more rounds and an important finding is still open.
The review rounds are the distinct `round` values of `review` findings.

## Rules

```bash
vp exec tinker-loop rules [ID...] [--app <dir>]
```

The rule text ships in `@tinker/start`, in `docs/rules.md`.
The command finds `@tinker/start` in the app's `node_modules` folders, as Node does.
It looks in the app folder, then in each parent folder.
It stops at the top folder of the app's git repo.
Outside git, it goes up to the root folder.
It never uses `NODE_PATH` or Node's global folders.
Those belong to the tool's runner, not to the app: pnpm's bin shims set `NODE_PATH`.
So each app reads the rules of its own Start version.
The first output line names that Start and its rules file: `@tinker/start 0.10.0: <path>`.
With no ID, the command prints every rule under its group heading.
With IDs, it prints only those rules, in the order asked.
IDs are not case sensitive: `b1` is `B1`.
An ID asked twice prints once.
An unknown ID exits 64 and lists the known IDs.
An app without Start exits 78.
A Start whose `package.json` cannot be read exits 78 and names the error code.
A Start without `docs/rules.md` exits 78.
A `docs/rules.md` that the parser cannot read exits 78 and names the line.

Other tools read the same file with `readRules` and `parseRules` from `@tinker/loop/rules`.

## Writing the file

Every tool that writes the file holds `.loop/findings.lock`.
It holds the lock around its read, merge, and write.
Use `updateFindings` from `@tinker/loop/findings`; it takes the lock for you.
The lock holds a token that only its owner knows.
The owner removes the lock only while it still holds that token.
A lock older than 10 seconds is stale.
A tool renames a stale lock to a unique name, then removes it.
Age is the only rule, since a pid means nothing across the sandbox and the host.
