<!--
Copied from branch claude/project-thread-donet0 (e528273),
apps/start-scaffold/.agents/skills/tinker-review/SKILL.md, section "## Rules".
Delete this fixture when that skill lands on next; the test then reads the skill itself.
-->

### G: gates

- `G1` Every gate in AGENTS.md passes.

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
- `C3` A new multi-step write, and the migrated board,
  counter, and todos writes, are one owned child call.
  Their steps use the session transaction only;
  they never open a session or commit. Old profile
  writes keep their awaited native transactions
  until their listed migration.
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
