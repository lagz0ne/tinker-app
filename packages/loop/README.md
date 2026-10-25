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
Check prints the folder it covers: `checked: apps/issue-board only`.
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
- `seenSha`: the HEAD commit when a tool last saw the finding.
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

Every tool that writes a finding sets its `seenSha`.
Check sets it on each finding it reports.
The review and judge tools must set it too.

Each check that runs to the end saves `.loop/last-check.json`.
It holds the round, the HEAD commit, the tree fingerprint, and each gate's result.
The tree fingerprint is a hash of `git diff HEAD` and the untracked files, names and bytes.
The fingerprint covers only the app folder.
Edits in other folders, such as a linked workspace package, do not change it.
Check takes the fingerprint after the gates run.
So files that the gates write do not block done.
`status` reads `last-check.json`.
A broken `last-check.json` makes `status` exit 78 and name the file.
Check skips a broken `last-check.json` and writes it again.
A broken `rounds.jsonl` line exits 78 and names the line to fix or delete.

## Review

```bash
vp exec tinker-loop review [--app <dir>] [--base <ref>]
```

`review` runs a separate reviewer model on the change.
The change is the same range as check's scan: from the merge base to the work tree.
The reviewer gets the app's tinker-review skill: `.agents/skills/tinker-review/SKILL.md`.
With no skill, it gets the review rules of the app's own Start, `docs/rules.md`.
Then review prints which rules it used.
With neither, review exits 78.
Review prints the folder it covers: `reviewed: apps/issue-board only`.
Changes in other folders of the repo are not reviewed.
No base, from `--base` or `loop.json`, exits 78.
An unknown `--base` exits 64.
The default reviewer is Claude Opus 5.5, `claude-opus-5-5`, run headless with `claude -p`.
It gets the tools Read, Grep, and Glob, and nothing that runs commands.
`--restricted` removes every tool that runs commands or code.
`--restricted` also ignores user, project, and local settings, so no setting can widen the tools.
`--permission-mode dontAsk` denies every other tool.
The reviewer runs in the app folder.
Its prompt goes on stdin.
`loop.json` can set another reviewer: `"review": { "command": ["node", "reviewer.mjs"] }`.
The prompt goes on its stdin too.
A `{prompt}` word in the command takes the prompt instead, and stdin is empty.
`"review": { "timeout": 600000 }` sets its timeout in milliseconds.
The default timeout is 20 minutes.
A reviewer past its timeout, or stopped, is killed with its whole process group.

Before the run, review writes the change to files, since the reviewer runs no commands.
`.loop/review/change.patch` holds the git diff from the merge base to the work tree, for the app folder.
`.loop/review/untracked.txt` lists the new files git does not know yet, one per line.
So the prompt stays small, however large the change is.
The prompt starts with a plain title line, so it never starts with `-` and never reads as an option.
Then come the skill, the range, the open review findings, and the answered review findings.
The prompt tells the reviewer to read the two files.
It asks for the skill's JSON lines only.
It tells the reviewer not to run the gates and not to report `G1`.
A `G1` line from the reviewer becomes a `question` row: gates belong to check.
It asks the reviewer to recheck each open review finding.
A finding that is still there comes back with the same `id`.
A fixed one comes back as `{"id": "<its id>", "status": "fixed"}`.
Answered review findings go in the prompt with the same fields as open ones, plus the reason.
A reworded repeat of an answered finding comes back with the same `id`.
So it updates that row, which stays answered, and adds no new open row.
`review-output` rows are never sent back, for recheck or as answered.
The prompt, the output, and the reviewer's stderr are saved in `.loop/review/`.

Each finding line becomes a row with `source` `review`.
Its `seenSha` is HEAD, and its `round` comes from `recordReviewRound`.
A new finding gets the loop's id, a hash, like a check finding.
A finding with an id from the prompt keeps that id.
A finding's `line` is a line in the file at the work tree.
A line past the end of its file becomes line 0, and its `trigger` gets a note with the given line.
Blank lines, code fences, and a `clear` line are skipped.
Any other line that is not a finding becomes one `question` row with rule `review-output`.
That row names the line and says why it is not a finding.
A bad line never stops the review.

The review records its round and merges under one hold of the findings lock.
A finding reported again follows the check rules.
An open finding stays open, an answered one stays answered, and a fixed one opens again.
An open review finding rechecked as fixed becomes `fixed` at HEAD.
An open review finding the reviewer does not mention stays open.

Exit code 0 means the review ran; findings are advice.
Exit code 1 means the reviewer failed or timed out.
Then nothing is written and no round is recorded.

## Review rounds

Each review round is one line in `.loop/rounds.jsonl`: `{ round, source, sha }`.
`tinker-loop review` records one round per review that runs.
It writes the line under the findings lock.
It stamps that round number on the findings of that round.
A round number is one more than any round in the findings, in `rounds.jsonl`, or in the last check.
`status` counts review rounds from `rounds.jsonl`.
So a finding that stays open across 3 reviews counts 3 rounds.

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
A finding with no `seenSha` takes `--fixed` only with `--sha`.
No tool recorded where it was seen, so you name the fix commit.
An amend or a rebase can drop the `seenSha` commit from HEAD's history.
Then `answer --fixed` says so; run the tool that saw the finding again.
`--reason` marks the finding `answered` with that reason.
An empty `--reason` exits 64.
An unknown ID exits 64.
A refused answer exits 64 and says why.
`answer` writes under the findings lock.
A refused answer writes nothing.
Answered and fixed findings stay in the file.
A later check that finds a `fixed` finding again opens it again.
A later check that finds an `answered` finding again keeps it `answered`.

## Status

```bash
vp exec tinker-loop status [--app <dir>]
```

`status` applies the stop rule.
Done means four things.
The last check ran at the current HEAD.
The work tree has not changed since that check, by the tree fingerprint.
Every gate was green in that check.
No `important` finding is `open`.
`status` prints one line for each open important finding.
Then it prints the verdict.
Exit code 0 means done.
Exit code 1 means not done.
The verdict lists each reason.
Exit code 2 means a person must check the work.
That is when `rounds.jsonl` has 3 or more review rounds and an important `review` finding is still open.
A red gate or another check finding alone never needs a person; it is not done.

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
The first output line names that Start and its rules file: `@tinker/start 0.11.0: <path>`.
With no ID, the command prints every rule under its group heading.
With IDs, it prints only those rules, in the order asked.
IDs are not case sensitive: `b1` is `B1`.
An ID asked twice prints once.
An unknown ID exits 64 and lists the known IDs.
An app without Start exits 78.
A Start whose `package.json` cannot be read exits 78 and names the error code.
A Start without `docs/rules.md` exits 78.
A `docs/rules.md` that the parser cannot read exits 78 and names the line.

Other tools read the same rules with `tinker-loop rules`.

## Writing the file

Every tool that writes the file holds `.loop/findings.lock`.
It holds the lock around its read, merge, and write.
Another tool that writes the file must hold the lock the same way.
The lock holds a token that only its owner knows.
The owner removes the lock only while it still holds that token.
A lock older than 10 seconds is stale.
A tool renames a stale lock to a unique name, then removes it.
Age is the only rule, since a pid means nothing across the sandbox and the host.

## How it is built

The loop is a CLI-only Tinker Start app (`docs/decisions/loop-on-tinker.md`).
Other apps use only its bin; the package exports no code.

- `cmds/cli.ts` reads the command line, binds the tags, runs one operation,
  and picks the exit code. No other file reads the context.
- `src/operations/` holds one operation for each command, and `gates`.
- `src/resources/` holds the work that touches the outside: child processes,
  the `.loop/` files and the lock, git, the app's Start rules, `loop.json`,
  the change scan, and the reviewer. Operations read no file themselves.
- `src/report.ts` is the one plain helper: the finding line and the summary.
- `bin/tinker-loop.mjs` runs the built `dist-cli/cli.js` with Start's `runMain`.
  `prepare` runs `tinker prepare`, then builds `dist-cli`.

## Frozen tests

The `tests/*.test.mjs` files are the loop's acceptance suite: 120 tests that
pin what the tool does from the outside. They run the command and read its
exit code, its output, and the files it writes. The port to a Tinker app must
pass them unchanged (`docs/decisions/loop-on-tinker.md`, ticket 5).

- The tests import only from `tests/api.mjs` and `tests/fixture.mjs`. A port
  changes those files, not the test bodies.
- `tests/frozen.json` holds the sha256 of each test file.
  `node maintain/check-frozen.mjs` fails on a changed, added, or removed file.
  CI runs it after the loop tests.
