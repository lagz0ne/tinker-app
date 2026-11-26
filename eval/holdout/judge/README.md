# Holdout judge (R1 to R8)

The judge for the room booking holdout. It is part of
the frozen holdout: do not change it to tune a model.
A gap found in a run goes in the report as a what-if
only.

It is the issue chain judge (`paths2.mjs` and
`rules2.mjs` as of run 20), with the rooms rules in
place of the issue rules. Its general parts stay on:
helper ops judged at their call sites, a member check
passed from a start hook in a tag, `await`, `view`
lines in `tinker.graph`, and a whole-cell read
filtered by key.

## Files

- `holdout-rules.mjs <tinker.graph> <step 1-4>`: R1 to
  R3, plain code over the graph.
- `holdout-paths.mjs --step <1-4> --graph <tinker.graph>
<file.ts>...`: R4 to R8, from the code's run paths.
  Give it `src/rooms/*.ts` but the given files
  (`contract.ts`, `index.ts`, `sign-in.ts`) and tests.
  It needs `typescript` at
  `~/.cuj-tools/node_modules/typescript`.
- `seeds/make-seed.py <R1..R8> <ops.server.ts>`: one
  negative seed per rule, as an edit of golden hb4's
  `src/rooms/ops.server.ts`.

Each line is `R<n> OK`, `R<n> VIOLATION <where>` or
`R<n> UNSURE <why>`. UNSURE counts as not OK. A step's
judge is OK when R1 to R7 (and R8 from hb4) are all OK.

## Rules

- R1: each call op of the step (`member.add.do`,
  `room.add.do`, `booking.make.do`, and
  `booking.cancel.do` from hb2, `room.remove.do` from
  hb4) reaches `rooms.inOffice` through its calls.
  `office.create.do` reads only `rooms.members`.
- R2: `rooms.membersOnly` reaches `rooms.inOffice`.
- R3: `rooms.signedIn`, `rooms.membersOnly` and
  `rooms.inOffice` (with their calls) write nothing.
- R4: no path to an answer of `gone`, `taken`, `exists`
  (and `notYours` from hb2) writes. A call to a helper
  op counts as that helper's writes.
- R5: `booking.make.do` and the ops it calls read
  bookings only keyed by `officeId`, `roomId` and `day`
  from the input. A whole-cell read of bookings is a
  violation.
- R6: the `by` that `booking.make.do` writes (or hands
  on in an object) comes from a tag (the caller), never
  from the input.
- R7: in each call op and the read hook, the member
  check runs before any room or booking is read.
- R8 (hb4): each write (set or delete) of rooms or
  bookings in `room.remove.do` and the ops it calls is
  keyed by `input.officeId`, or by a row read keyed by
  it.

## Proof (2026-11-26, at the freeze)

- Golden hb1 to hb4: every R line OK (7, 7, 7, 8).
- Each seed of `seeds/make-seed.py` on golden hb4, with
  its own `tinker graph`: its rule says VIOLATION.

| seed | edit                                           | result       |
| ---- | ---------------------------------------------- | ------------ |
| R1   | `member.add` runs no member check              | R1 VIOLATION |
| R2   | the read hook lets every part through          | R2 VIOLATION |
| R3   | the start hook writes a member row             | R3 VIOLATION |
| R4   | a `taken` booking still writes                 | R4 VIOLATION |
| R5   | the overlap read is `where({ officeId, day })` | R5 VIOLATION |
| R6   | `by: input.start`                              | R6 VIOLATION |
| R7   | the room is read before the check              | R7 VIOLATION |
| R8   | remove deletes every booking of the room id    | R8 VIOLATION |
