# Task, step 11: a big team is deleted

You built the issue board in steps 1 to 10. Your
code is in this folder. `TASK-ck1.md` to
`TASK-ck10.md` are the tasks before this one. They
still hold, except where this file says a part
changes.

You work in this folder only. Do not read files outside it.

## What is new

No file is new. The given files stay given, as in
step 10. `cmds/server.ts` stays yours, and so does
the list `serverParts` (step 10): the tests install
it on the server.

## Server journeys

S15 changes. A team can be big: thousands of
issues. A delete must not hold the server while
its parts go.

- `team.delete` answers `{ kind: "deleted" }` at
  once, also for a big team.
- The team is hidden at once. Its members are out
  of it at once. Every call that names it answers
  `gone`. Every read of its parts is refused, also
  a read a tab has open now. A person's own list of
  teams drops it at once.
- Its other parts (issues, labels, events, the
  archive mark) go later: at most 100 parts in each
  second of the server's clock, and all of them
  within 1 minute.
- Until its last part is gone, its key is not free:
  `team.create` with it answers `exists`, and the
  caller does not join. After that, a team made
  with the key starts empty, as in step 8.
- Another team is not changed by this one.
- A delete sent twice, or by two members at once,
  deletes once: one `deleted`, the others `gone`.
  A team made again with the key keeps its parts,
  however long the server runs, until it is
  deleted itself.
- The server can stop while parts are still
  going. Its close then ends at once.

Outside, `gone` and `forbidden` as in step 8. An
archived team can be deleted too.

Time is the server scope's clock only.

## Page journeys

P1 holds: "Open team" on a key whose old team is
still going shows that the person is not in that
team. Once the old parts are gone, it makes a new
team.

## Rules your server keeps

R1 to R8 hold, as in step 10.

Judge your server again. Write `RULES.md` again.

## Done means

The same as before. Hidden tests check the journeys
of steps 1 to 11 that still hold.
