# Holdout chain: room booking (hb1 to hb4)

A frozen holdout for the CUJ chain (`eval/chain`). It
checks that a writer model that is strict on the issue
board chain is not fit to that one board. Same Tinker
parts (keyed remote data, rpc, start hooks, a member
check op, live parts, faults), a new domain: an office
books its rooms.

Do not change these files to tune a model. A change
makes a new holdout; name it `hb-v2` and say why.

The rules of the chain hold here: a step runs on the
writer's own tree, in a fresh session; all earlier
tests run again; a step that is not strict ends the
chain. See `eval/chain/README.md`.

## Steps

- hb1: offices, members, rooms, bookings. A booking
  that overlaps one of the same room and day answers
  `taken`. Pages `/rooms` and `/rooms/<office>/<day>`.
- hb2: `booking.cancel`. Only the booker; another
  member gets `notYours`. A Cancel button on own
  bookings only.
- hb3: `/rooms/<office>/mine`, read by
  `{ officeId, by }`. The read hook lets a person read
  their own rows; another person's rows, by part or by
  whole key, take the office check.
- hb4: `room.remove` takes the room and all its
  bookings in one call. Open tabs see it with no reload.

## Files

- `make-tree.sh <start|golden> <hbN> <out>`: builds a
  tree. Base = tinker-app `20b7954` (`@tinkered/*`
  0.34.10) with the issue board taken out: `src/issues`,
  its two tests, its README section, `tinker.graph`, and
  `graph` in `tinker.json` (`start/tinker.json`).
  - `start hb1`: base + `hb1/given` + `hb1/TASK.md`. No
    `tinker.graph`: the writer makes it.
  - `golden hbN`: base + `given` of hb1 to hbN + `hbN/golden`
    - `hbN/hidden` (the hidden tests are the golden's
      tests).
  - `PORT=<n>` sets the browser test port, as
    `make-task.sh` does.
- `start/tinker.json`: the base `tinker.json` with no
  `graph` key. A writer may add `graph.rules` (TASK hb1).
- `hbN/TASK.md`: the step's task. hb2 to hb4 are deltas.
- `hbN/given/`: files copied over the tree, by their
  path in the tree (`given/src/rooms/contract.ts`), not
  flat as in `eval/chain`. Read-only for the writer.
  - hb1: `src/rooms/{contract,index,sign-in}.ts`,
    `src/routes.tsx`, `cmds/server.ts`, `cmds/browser.tsx`.
  - hb2: `src/rooms/contract.ts` (+ `booking.cancel`).
  - hb3: `src/routes.tsx` (+ `/rooms/$office/mine`).
  - hb4: `src/rooms/contract.ts` (+ `room.remove`).
- `hbN/golden/`: the golden's answer files:
  `src/rooms/ops.server.ts`, `src/rooms/pages.tsx`,
  `tinker.graph`.
- `hbN/hidden/`: `rooms-feature.test.ts` (to `tests/`)
  and `room-booking.test.tsx` (to `tests/browser/`).
  Each step's files only add tests: every earlier test
  is byte-equal.
- `hbN/new-tests.txt`: the test names new at that step
  (hb1: all of them).
- `seeds/`: one real fault per step, as a patch on the
  golden tree, and `prove.sh <golden-tree> <patch>`.

## Run one chain

1. `make-tree.sh start hb1 <tree>`. Hash the given
   files for the manifest, as `make-task.sh` does.
2. Run the writer on hb1. Score it.
3. Rename `TASK.md` to `TASK-hb1.md`. Copy
   `hb2/given/.` over the tree root. Put `hb2/TASK.md`.
   Commit the tree. Start a NEW writer session.
4. The same for hb3 and hb4.

## Score of a step

As the chain: strict = hidden tests of that step all
pass, `tinker check: OK`, `check:style`, typecheck,
given files byte-equal (`tinker.json` with only a
`graph` change counts as unchanged), and the judge says
OK for each R rule. Iso = the tests in
`new-tests.txt` pass.

The judge rules are text in each TASK (R1 to R7 from
hb1, R4 grows at hb2, R2 changes at hb3, R8 is new at
hb4). The CUJ launcher adds the judge code.

## Golden

Each golden tree (`make-tree.sh golden hbN`):
`tinker check: OK`, `bun run check:style`,
`bun run check` pass on 0.34.10.

| step | hidden server | hidden page | all |
| ---- | ------------- | ----------- | --- |
| hb1  | 8             | 9           | 17  |
| hb2  | 9             | 12          | 21  |
| hb3  | 10            | 14          | 24  |
| hb4  | 11            | 16          | 27  |

## Seeds

`seeds/prove.sh <golden-tree> seeds/<patch>`: applies
the seed, runs the step's hidden tests, reverts. Caught
= one hidden test or more fail.

| step | seed                                                                | hidden on its step | hidden on hb4 |
| ---- | ------------------------------------------------------------------- | ------------------ | ------------- |
| hb1  | `hb1-overlap-all-rooms`: overlap read by office and day, all rooms  | 1 of 17 fail       | 4 of 27 fail  |
| hb2  | `hb2-cancel-by-anyone`: no `notYours` check                         | 1 of 21 fail       | 1 of 27 fail  |
| hb3  | `hb3-any-by-part-passes`: any part with `by` skips the office check | 2 of 24 fail       | 2 of 27 fail  |
| hb4  | `hb4-remove-leaves-bookings`: remove deletes the room only          | 1 of 27 fail       | 1 of 27 fail  |

R8 (`room.remove` writes no booking of another office)
has no hidden test: room ids are random, so two offices
never share one. The judge checks it.

## Task gaps closed

Each hidden assertion was read against the TASK text.
Gaps found and closed:

- hb1 P2: the select `Room` is found by its exact name.
  A wrapping `<label>` adds the options' text to the
  name (the chain hit this at ck4). TASK says so.
- hb1 P3: the "Open office" test opens an office with
  no room and wants `Book`. TASK: the form shows when
  both reads are ready, also with no room.
- hb1 P3: "any other fault" shows the trace id. The
  golden page showed `missing` without it; the golden
  now falls through to the trace id alert. TASK says a
  call's `link` fault may be a status.
- hb2 P4: the test counted Cancel buttons by their text;
  now by their name, as the TASK states.
- hb1 P2: the taken test looked for `09:30` in the
  region, which fails a message that repeats the span.
  Now it looks for the booking line `09:30-10:30 ana`.
- hb1: TASK now says Sign in runs `signIn`; an office
  nobody made gets the same `notMember` refusal (the
  Try again test opens one); a booking line is one run
  of text with plain spaces (hb3 too); no call needs an
  `invalidate` (it could set a part back to loading and
  show two statuses).
- hb2 P4: the Cancel count matches the full name
  `Cancel 09:00-10:00`, so a button like "Cancel
  booking" does not count.
- hb4 P6: the test wanted the options to be exactly
  `["Green"]`, which fails a placeholder option. Now:
  no `Blue`, has `Green`.
