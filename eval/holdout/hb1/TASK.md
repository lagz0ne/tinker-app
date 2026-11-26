# Task: build room booking (server ops + pages)

You work in this folder only. Do not read files outside it.
Do not use git. Git is not scored.

The contract is given. Do not change these files:

- `src/rooms/contract.ts`
- `src/rooms/sign-in.ts`
- `src/rooms/index.ts`
- `src/routes.tsx`, `cmds/**`

Change no other file that is already here (config,
`tinker.json`, the other features, their tests).
The scorer checks each one. You add files only.
One exception: you may add `graph.rules` to
`tinker.json`. Do not change its other keys.

Write two files, and your own tests for them:

- `src/rooms/ops.server.ts` exports `roomOps`, `signedIn`, `membersOnly`.
- `src/rooms/pages.tsx` exports `RoomsHome`, `DayBoard`.

The cmds already install them:

```ts
rooms.board({ serve: true, onStart: [signedIn, membersOnly] }),
rooms.api({ implement: roomOps, onStart: [signedIn] }),
```

`src/routes.tsx` draws `RoomsHome` at `/rooms`, and
`<DayBoard officeId day />` at `/rooms/<office>/<day>`.

Follow `AGENTS.md`. Load the Tinker skills first. Look at
`src/todo` for a feature that is already done.

`tinker.graph` is not here. Make it with `bunx tinker graph --write`.

## The words

- An office has members and rooms. Its key is its id,
  such as `HQ`.
- A booking holds one room of the office on one day,
  from `start` up to `end`. Its fields:
  `{ officeId, roomId, day, id, start, end, by }`.
- A day is `2026-12-01`, a time is `09:30`. Two times
  compare as text.
- Two bookings overlap when `a.start < b.end` and
  `b.start < a.end`. So `09:00-10:00` and `10:00-11:00`
  do not overlap.
- `by` is the person who booked: the caller.
- A part is what a tab reads of a keyed cell:
  `where({ officeId })` and so on.

## Server journeys

S1. An office is made once.

- `office.create` on a new key answers
  `{ kind: "created", officeId }`, with the key as the
  contract made it (upper case): `hq` gives `HQ`.
- The caller becomes its first member, and its only one.
- Again on the same key answers
  `{ kind: "exists", officeId }`.
- `exists` changes nothing: a caller who is not in the
  office stays out of it.

S2. Members and rooms.

- `member.add` answers `{ kind: "added" }`, and the user
  is a member of the office.
- `room.add` answers `{ kind: "added", roomId }`. The
  office has a new room `{ officeId, id: roomId, name }`.
- A room added on one tab shows in the rooms part
  (`where({ officeId })`) of another tab, with no reload.

S3. A booking takes a room for a span of one day.

- `booking.make` answers `{ kind: "booked", id }`. The
  office has the new booking with that `id`, the input's
  room, day, start and end, and `by` = the caller.
- When the span overlaps a booking of the same room on
  the same day, it answers `{ kind: "taken" }` and
  changes nothing. The same span again is `taken` too.
- A span that only touches another one is free:
  `10:00-11:00` after `09:00-10:00`.
- The same span in another room, or on another day, is
  free.
- A booking writes one booking, once: one write, so one
  signal to the tabs.

S4. A booking on one tab shows on another tab with no
reload. That tab reads the day's part,
`bookings.where({ officeId, day })`.

S5. Who may do what.

- A call or a read with no `who` in its meta is refused
  (`input.refuse(...)`), so the tab gets a `refused` fault.
- A signed-in caller who is not in the office gets
  `{ kind: "gone" }` on every call that names that office
  (`office.create` aside): `member.add`, `room.add`,
  `booking.make`.
- A read of an office's part by a non-member is refused
  with payload `{ notMember: officeId }`; the tab's part
  is a fault. This holds for each part: members, rooms,
  bookings. Such a tab sees no booking. An office that
  nobody made yet has no member, so its parts get the
  same refusal.
- A booking that names a room the office does not have
  answers `gone`. A room of another office is not a room
  of this office.
- A call that answers `gone` writes nothing.

S6. A person added while their tab is open sees the
office after "Try again" (an `invalidate` of the part).

S7. One booking is one trace. Use these operation labels:

- `rooms.signedIn` — the start hook on calls and reads.
- `rooms.membersOnly` — the start hook on reads.
- `rooms.inOffice` — the member check. Each call that
  names an office runs it once, before it reads a room
  or a booking. Each read runs it too. It answers true
  or false; the call answers `gone`.
- `<address>.do` — the op behind each address,
  for example `booking.make.do`.

A trace holds these operations of yours:

- a call: `rooms.signedIn`, `rooms.inOffice`,
  `<address>.do`, never `rooms.membersOnly`;
- a read: `rooms.signedIn`, `rooms.membersOnly`,
  `rooms.inOffice`.

It may also hold ops of your own that they run. So the
read hook runs `rooms.inOffice` for its check.

## Page journeys (React, real Chromium)

Roles and control names below are exact: a test finds
a control by its role and name, as a person does. The
words of a message are yours: a test looks for its role
(`status` or `alert`) and for what the page does, not
for the words.

P1. `/rooms`: a form with input `Your name` and button
`Sign in`. Sign in runs `signIn` of
`src/rooms/sign-in.ts`, so each later call and read
carries the name as `who`. When signed in, a form with input
`Office key`, input `Day` and button `Open office`.
Opening calls `office.create` with the key as typed,
then goes to `/rooms/<officeId>/<day>`: the key in the
answer, the day as typed (`2026-12-01`). So a new key
makes the office, and a key that exists opens it: `new`
opens `/rooms/NEW/2026-12-01`. The page does not change
the key itself.

P2. `/rooms/<office>/<day>`: a heading whose text is the
office key alone (`HQ`).

- Form: a select `Room`, inputs `Start` and `End`
  (`09:00`), button `Book`. Each option of `Room` shows
  a room's name. Book calls `booking.make` for that day.
  The select's name is `Room` alone: a `<label>` that
  wraps a select adds the options' text to its name, so
  name it with `aria-label` or a `<label for>`.
- One region per room of the office:
  `<section aria-label="Blue">`, by the room's name.
- A region lists its room's bookings of that day, by
  start. Each booking shows as `09:00-10:00 ana`
  (start, end, booker): one run of text, with plain
  spaces.
- The page shows no booking of another day, and a
  booking only in its own room's region.
- A booking on another tab shows here with no reload.
- `taken` shows a status, and nothing is booked.
- `gone` shows a status.

P3. Faults, each a message in `role="alert"` or
`role="status"`, in your words.
On the day page these sit inside its `<main>`:

- A page state shows one message. Keep no other
  `role="status"` or `role="alert"` element on the page.
- The page draws from its reads alone: the rooms part
  and the day's bookings part. It waits for both. When
  both are ready, the form shows, also when the office
  has no room yet.
- No call needs an `invalidate`: the server's write
  reaches every tab's part, this tab's too. A ready
  part stays ready, and the call's message stays.

- Not read yet: a status in place of the page (no
  `<form>` element).
- Read refused, not in office: an alert and a button
  `Try again`. It asks again for each part of the page,
  so the page shows once the person is in.
- Read refused, not signed in: an alert in place of
  the page (no `<form>` element).
- Read lost its link (server gone): a status in place
  of the page (no `<form>` element), no `Try again`
  button.
- Any other fault, such as a call that broke on the
  server (`failed`): an alert that holds the first 8
  characters of the fault's trace id (`error.traceId`).
  A call's `link` fault (no answer) may be a status.

## Rules your server keeps

A judge reads your server code against these rules.
Each rule is OK, or a violation at a file and line.

- R1. Each call that names an office runs
  `rooms.inOffice` first. `office.create` is the one
  exception. It reads only `members`.
- R2. The read hook runs `rooms.inOffice` and refuses a
  non-member for each part: members, rooms, bookings.
- R3. The start hooks and `rooms.inOffice` write
  nothing.
- R4. An answer of `gone`, `taken` or `exists` writes
  nothing.
- R5. The overlap check reads the bookings of one room
  on one day: `where({ officeId, roomId, day })`. It
  never reads every booking of the office or of the day.
- R6. A booking's `by` is the caller, never a field of
  the input.
- R7. The member check runs before any booking or room
  is read.

Before you finish, judge your own server against each
rule, the way the judge will. For each rule, write one
line in `RULES.md`: `R1 OK`, or `R1 VIOLATION
src/rooms/ops.server.ts:<line> <why>`. Fix each
violation, then judge again.

## Done means

- `bun run check:plain` prints `tinker check: OK`.
- `bun run check:style` passes.
- `RULES.md` says OK for each rule.

`tinker check` runs your tests. It fails for each exit
of an operation that no test of yours reaches: each
answer `kind`, a refusal, a plain return. So write a
test for each one. `AGENTS.md` shows the capsule that a
test scope lists.

Hidden tests check the journeys above too.
