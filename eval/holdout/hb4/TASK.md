# Task, step 4: remove a room

You built room booking in steps 1 to 3. Your code is
in this folder. `TASK-hb1.md`, `TASK-hb2.md` and
`TASK-hb3.md` are the tasks of those steps. All of them
still hold, so all of their journeys are tested again.

You work in this folder only. Do not read files outside it.

## What is new

The contract changed. `src/rooms/contract.ts` is
given again, with one new call: `room.remove`. Do not
change that file, or the other given files of steps 1
to 3.

Change your own files: the ops, the pages, your tests.

## Server journeys

S10. A room goes with all its bookings, in one call.

- `room.remove` names the office and the room. Any
  member may remove a room. It answers
  `{ kind: "removed" }`.
- When the call answers, the room is gone, and every
  booking of it, on every day, by every person, is
  gone. The other rooms and their bookings stay.
- A caller who is not in the office gets `gone`. So
  does a room the office does not have. A room is found
  by office and id: another office's room is `gone`.
  `gone` writes nothing.
- A room removed already is `gone`.
- A booking of a removed room answers `gone`.
- Open tabs see the room and its bookings go, with no
  reload.
- A remove runs `rooms.inOffice` once, as each call
  does (S7), also when the room is not there.

## Page journeys

P6. A room removed on another tab leaves each open
page, with no reload.

- The day page: its region goes, and the select `Room`
  has no option for it. The other rooms and their
  bookings stay.
- `My bookings`: its bookings go, and the page names
  the room nowhere. The other bookings stay.

The pages need no button to remove a room.

## Rules your server keeps

R1 to R7 hold, as step 3 left them. One is new:

- R8. `room.remove` writes no booking and no room of
  another office.

Judge your server again against each rule. Write
`RULES.md` again, one line per rule.

## Done means

The same as step 1: `tinker check: OK`,
`check:style`, `bun run check`, and `RULES.md` all OK.
Hidden tests check the journeys of steps 1 to 4.
