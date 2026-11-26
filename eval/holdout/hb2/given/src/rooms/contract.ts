import { data, remoteData, rpc } from "@tinkered/core";
import { z } from "zod";

// The room booking contract: both sides import it. An office has members and rooms; a member books
// a room for a span of one day. Every key starts with `officeId`, so one guard checks every part.
// Every cell is served: a cell that is not served is a copy per session, so a call's write to it
// would end with the call.

/** A day as `2026-12-01`. */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** A time of day as `09:30`, 24 h. Two of them compare as text: `"09:30" < "10:00"`. */
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const member = z.object({ officeId: z.string(), userId: z.string() });

const room = z.object({ officeId: z.string(), id: z.string(), name: z.string() });

export type Room = z.infer<typeof room>;

/** One booking: the room is taken from `start` up to `end`, not at `end` itself. */
const booking = z.object({
  officeId: z.string(),
  roomId: z.string(),
  day,
  id: z.string(),
  start: time,
  end: time,
  by: z.string(),
});

export type Booking = z.infer<typeof booking>;

/** Who is in which office. An office is its first member: `HQ` exists once someone made it. */
export const members = data({
  label: "rooms.members",
  mode: "keyed",
  parse: member,
  key: (m) => ({ officeId: m.officeId, userId: m.userId }),
});

/** The rooms, by office: a tab reads one office with `where({ officeId })`. */
export const rooms = data({
  label: "rooms.list",
  mode: "keyed",
  parse: room,
  key: (r) => ({ officeId: r.officeId, id: r.id }),
});

/**
 * The bookings. A tab reads one office's day with `where({ officeId, day })`; the server reads one
 * room's day with `where({ officeId, roomId, day })`.
 */
export const bookings = data({
  label: "rooms.bookings",
  mode: "keyed",
  parse: booking,
  key: (b) => ({ officeId: b.officeId, roomId: b.roomId, day: b.day, by: b.by, id: b.id }),
});

/** Read: each part goes only to the members of its office. */
export const roomBoard = remoteData({ members, rooms, bookings });

const office = z.object({ officeId: z.string() });
const gone = z.object({ kind: z.literal("gone") });

/** Ask: every change is a call; the server is the only writer. Outcomes are output. */
export const roomApi = rpc({
  "office.create": {
    input: z.object({
      officeId: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z][A-Z0-9]{1,9}$/),
    }),
    /** The key as the server keeps it: the page opens the office there, never at its own copy. */
    output: z.object({ kind: z.enum(["created", "exists"]), officeId: z.string() }),
  },
  "member.add": {
    input: office.extend({ userId: z.string().trim().min(1) }),
    output: z.discriminatedUnion("kind", [z.object({ kind: z.literal("added") }), gone]),
  },
  "room.add": {
    input: office.extend({ name: z.string().trim().min(1).max(40) }),
    output: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("added"), roomId: z.string() }),
      gone,
    ]),
  },
  /** The booker is the caller. `taken`: the room has a booking that overlaps, that day. */
  "booking.make": {
    input: office
      .extend({ roomId: z.string(), day, start: time, end: time })
      .refine((b) => b.start < b.end, { message: "end must come after start" }),
    output: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("booked"), id: z.string() }),
      z.object({ kind: z.literal("taken") }),
      gone,
    ]),
  },
  /** Only the booker cancels: another member gets `notYours`, and nothing changes. */
  "booking.cancel": {
    input: office.extend({ id: z.string() }),
    output: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("cancelled") }),
      z.object({ kind: z.literal("notYours") }),
      gone,
    ]),
  },
});
