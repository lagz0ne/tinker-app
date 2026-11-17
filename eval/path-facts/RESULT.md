# Path facts from code: quick eval

Date: 2026-11-17. Script: `paths.mjs` (scratch,
TypeScript 5.9 API, about 250 lines).

It walks each path of an op body (if, ?:, &&,
||, early return, loop as 0 or 1 turn). It
records calls, reads, writes and the exit kind
(from the type checker when the kind sits in a
const). Code it cannot see (a callback, a cell
handed to a helper) gives a "may" write.

Facts it prints, generic to any Tinker app:

```
W issue.move.do stale {issues@90}
O issue.move.do issues read-before
  issues.inTeam: yes @83
```

The CUJ's join (J1, J6) reads those facts.

## Result: 31 files

- 5 seeded variants (v-a to v-e).
- 21 past writer apps (t01 to t21).
- 5 new fault shapes (m7 to m11).

J1 (no write on gone, stale, exists):

- v-b stale writes @90: caught.
- v-c exists writes @47: caught.
- m8 write in a callback: caught as "may".
- m9 write before the gone check: caught.
- m10 exists returned from a const: caught.

J6 (check before any issue read):

- t14 read @83: caught.
- m7 comment reads first: caught.
- m11 read hidden in `&&`: caught.

False violations: 0 of 22 clean files.
Unknown deps or kinds: 0 left after the fix
for import aliases (t07) and kind consts (t01).

## Limits

- A helper in another file is "may" only when
  it gets a cell; one that reaches a cell by
  closure is not seen. Tinker bans plain
  helpers, so ops are the only callees.
- Exit kinds from imported types need the full
  program (here: noResolve; t21 shows 3 exits
  as "value", none of which write).
- Two rules only. J3, J4, J5, J7 are still for
  the reader.
