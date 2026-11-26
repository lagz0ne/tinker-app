# Task, step 2: cancel a booking

You built room booking in step 1. Your code is in
this folder. `TASK-hb1.md` is the task of step 1. All
of it still holds, so all of its journeys are tested
again.

You work in this folder only. Do not read files outside it.

## What is new

The contract changed. `src/rooms/contract.ts` is
given again, with one new call: `booking.cancel`. Do
not change that file, or the other given files of
step 1.

Change your own files: the ops, the pages, your tests.

## Server journeys

S8. Only the booker cancels a booking.

- `booking.cancel` names the office and the booking's
  `id`. The booker gets `{ kind: "cancelled" }`, and the
  booking is gone from the office.
- Another member gets `{ kind: "notYours" }`, and
  nothing changes.
- A caller who is not in the office gets `gone`. So
  does an id the office does not have. A booking is
  found by office and id: the id of another office's
  booking is `gone`.
- A booking cancelled already is `gone`.
- A cancel shows on the other tab with no reload.
- A cancelled span is free again: the same room, day
  and span can be booked.
- A cancel runs `rooms.inOffice` once, as each call
  does (S7), also when the booking is not there.

## Page journeys

P4. On the day page, each booking of this tab's person
has a button `Cancel 09:00-10:00` (`Cancel`, then the
booking's start and end). Another person's booking has
no Cancel button.

- A click cancels the booking. It leaves the page.
- A cancel on another tab leaves this page too, with
  no reload.
- `notYours` or `gone` shows a status. The booking
  stays on the page until the server takes it away.
- P3 holds: one message per state.

## Rules your server keeps

R1 to R7 of step 1 hold. One changes:

- R4. An answer of `gone`, `taken`, `exists` or
  `notYours` writes nothing.

Judge your server again against each rule. Write
`RULES.md` again, one line per rule.

## Done means

The same as step 1: `tinker check: OK`,
`check:style`, `bun run check`, and `RULES.md` all OK.
Hidden tests check the journeys of step 1 and step 2.
