---
name: tinker-review
description: Review app changes against the authoring contract.
---

# Review a change

The other tinker skills write code. This skill reviews it.
Use the same [authoring contract](https://github.com/lagz0ne/tinker-app/blob/next/docs/decisions/start-decompose.md) they use.
Each finding names one rule ID from the list below.

```text
write: tinker-forms, -feature, -seams,
       -sync, -testing
  |
  v  commit
review: tinker-review
  |
  v  findings
fix, or answer with a reason
  |
  v  review the new commits only
3 rounds with an important finding:
a person checks the approach
```

## Scope

- Review only the change: `git diff <base>..HEAD`.
- A problem in code the change did not touch is `old`.
- Read the contract before the diff.
- Do not edit files. Report findings only.

## Gates first

Run the gates in AGENTS.md, in its order.
A red gate is finding `G1`, severity important.
Name the gate and its first error.

## Quick scan

These greps point at lines to read.
A hit is not a finding until you read the code.

```bash
D="git diff <base>..HEAD"
$D --name-only
$D | grep -nE 'process\.(env|argv|exit)'
$D | grep -nE 'Date\.now|Math\.random'
$D | grep -nE 'randomUUID|setInterval'
$D | grep -nE '^\+.*\bclass [A-Z]'
$D | grep -nE '\bfetch\(|node:(net|http)'
$D | grep -nE ' as unknown as |\.skip\('
```

## Rules

### B: own the boundary

- `B1` Only `cmds/*` reads app inputs.
  Other code never reads process globals or env files.
- `B2` Only `cmds/*` and scope tests create roots.
- `B3` Unit bodies use the unit's clock, random,
  signal, and defer, not `Date.now` or `Math.random`.
- `B4` Outside libraries enter through lazy module
  resources in the owner's `modules.ts`.

### I: imports go one way

- `I1` Components never import base, `@/`, or cmds.
- `I2` Components declare direct `requires`
  in `component.json`.
- `I3` App code uses component public entries.
  Only tests may import the private file they prove.
- `I4` No forwarding barrel hides an owner.
- `I5` Four import groups at the top, no `.ts` endings,
  blank lines between steps. Severity: nit.

### O: declare work and its owner

- `O1` No authored classes. No live client, timer,
  queue, or watcher at module scope.
- `O2` A resource releases its owned work with defer.
- `O3` A plain helper is pure, has at most three plain
  value inputs and two real callers, TSDoc,
  and a `PLAIN.md` entry. The cap stays 17.
- `O4` No helper takes a scope, session, context bag,
  controller, clock, signal, or IO object.
- `O5` React props carry no Core handles or signals.

### S: bind only real seams

- `S1` A component declares typed tags.
  It never takes an env object or a text converter.
- `S2` The command binds host config inline and checks
  required startup values before ready.
- `S3` Request values bind per call.
- `S4` Mandatory component work is a direct import:
  no hook slots, saved context, or AsyncLocalStorage.
- `S5` A tag default does useful work with no choice.

### C: close before success

- `C1` A command uses `defineMain`, returns `closed`,
  and starts nothing on import.
- `C2` Only the command picks the exit code.
  Its outer catch calls `exit`; it does not rethrow
  or print the error again.
- `C3` A multi-step write is one owned child call.
  Its steps use the session transaction only;
  they never open a session or commit.
- `C4` The call closes before success, reply bytes,
  or progress output. A failed COMMIT fails the call.
- `C5` Page, bootstrap, and account reads write nothing.
- `C6` Lock order, guards, execution receipts, stream
  history, and outbox rows share one transaction.
  Board mail goes through the outbox.
- `C7` A repeated execution ID does not repeat effects.

### H: HTTP and tests

- `H1` Routes and server functions own Request and
  Response. Operations take checked plain input.
- `H2` Raw input is checked at the operation boundary.
  The code uses the checked result, not a type cast.
- `H3` Outgoing HTTP uses `httpRequest.controller`.
  No raw fetch, socket, or HTTP client in features.
- `H4` Tests run serial and bind typed tags.
  They never patch global fetch, clocks, or module state.
- `H5` No skipped or quarantined test.
  A fault control fails for its named cause.
- `H6` A new write test proves failed COMMIT, no early
  reply, rollback, idle no-checkout, and ended handles.

## Judge each finding

1. Read the code at the line, not only the diff.
2. Trace a real path from a caller or input to the
   broken rule. If you cannot, drop the finding.
3. Name the class of the problem, so the writer fixes
   every place, not one line.
4. If the contract does not decide the case, do not
   guess. Report it as a question and name the rule.

Severity:

- `important`: breaks a rule above on changed code,
  or breaks behavior.
- `nit`: style only.
- `old`: real, but the code was there before.
- `question`: the contract does not decide it.

All findings are advice. None blocks a merge.
The writer still fixes or answers each one.

## Report

One JSON line per finding, no other text:

```json
{"id":"slug","rule":"C3",
 "severity":"important",
 "file":"src/x.ts","line":12,
 "summary":"one sentence",
 "trigger":"the path that breaks",
 "fix":"one sentence"}
```

No finding: print `clear` and the gates you ran.
