# Task, step 3: my bookings

You built room booking in steps 1 and 2. Your code is
in this folder. `TASK-hb1.md` and `TASK-hb2.md` are the
tasks of those steps. All of them still hold, so all of
their journeys are tested again.

You work in this folder only. Do not read files outside it.

## What is new

`src/routes.tsx` is given again, with one new route:
`/rooms/<office>/mine` draws `<MyBookings officeId />`.
Do not change that file, or the other given files of
steps 1 and 2. The contract did not change.

`src/rooms/pages.tsx` now exports `MyBookings` too.

Change your own files: the ops, the pages, your tests.

## Server journeys

S9. A person reads their own bookings by `by`.

- The page reads `bookings.where({ officeId, by })`,
  with `by` = the signed-in person. The part holds that
  person's bookings in the office, on every day, and
  no one else's. A new one shows with no reload.
- A person may always read their own bookings, in or
  out of the office: a part of bookings whose `by` is
  the caller goes to the caller with no office check.
  That holds for `where({ officeId, by })` and for
  `where({ by })` with no office.
- Another person's bookings take the office check, as
  every part does (S5). A member reads them; a
  non-member is refused with `{ notMember: officeId }`.
- The check holds for one booking by its whole key too,
  `of({ officeId, roomId, day, by, id })`. Core asks
  for a changed row by its whole key, so the read hook
  sees these keys.

S7 changes a little. A read of your own bookings may
skip `rooms.inOffice`. Every other read runs it.

## Page journeys

P5. `/rooms/<office>/mine`: a heading `My bookings`.

- Inside `<main>`, one line per booking of this person
  in the office, on every day, by day, then by start.
- Each line shows as `2026-12-01 09:00-10:00 Blue`
  (day, start, end, the room's name): one run of text,
  with plain spaces.
- Another person's booking is not on the page.
- A booking or a cancel on another tab of the same
  person shows here with no reload.
- P3 holds here: one message per state. Not signed in:
  an alert.

## Rules your server keeps

R1 to R7 hold, as step 2 left them. One changes:

- R2. The read hook runs `rooms.inOffice` and refuses a
  non-member for each part: members, rooms, bookings.
  One exception: a part of bookings whose `by` is the
  caller. Another person's bookings, by part or by whole
  key, take the check.

Judge your server again against each rule. Write
`RULES.md` again, one line per rule.

## Done means

The same as step 1: `tinker check: OK`,
`check:style`, `bun run check`, and `RULES.md` all OK.
Hidden tests check the journeys of steps 1 to 3.
