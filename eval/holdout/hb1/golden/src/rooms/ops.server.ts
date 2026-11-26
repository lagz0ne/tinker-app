import { operation, tag, transport } from "@tinkered/core";
import { z } from "zod";

import { bookings, members, roomApi, roomBoard, rooms } from "./contract";

// The server's work for `roomApi`. Each op writes members of the keyed cells; `roomBoard` tells
// every member's tab that reads the part, and the tab asks for that part alone.

/** Who calls: `signedIn` binds it for each call and each read. */
const caller = tag<string>({ label: "rooms.caller" });

/** Every call and read: no `who` in its meta, no service; else it runs as the caller. */
export const signedIn = operation({
  label: "rooms.signedIn",
  input: transport.hook.start,
  run: (_, { input }) => {
    const me = input.meta.who;
    return me ? { tags: [caller(me)] } : input.refuse({ signIn: true });
  },
});

/** The member check: the caller is a member of the office the input names. Calls and reads run
 * it, before anything else of the office is read. */
const inOffice = operation({
  label: "rooms.inOffice",
  input: z.object({ officeId: z.string() }),
  depends: { office: members.controller, me: caller.required },
  run: ({ office, me }, { input }) => !!office.of({ officeId: input.officeId, userId: me }).get(),
});

/** Every read of a part: the caller must be a member of the part's office. */
export const membersOnly = operation({
  label: "rooms.membersOnly",
  input: transport.hook.start,
  depends: { ok: inOffice },
  run: ({ ok }, { input }) => {
    const officeId = roomBoard.part(input)?.officeId ?? "";
    return ok.run({ input: { officeId } }) ? undefined : input.refuse({ notMember: officeId });
  },
});

const createOffice = operation({
  label: "office.create.do",
  input: roomApi["office.create"].input,
  depends: { office: members.controller, me: caller.required },
  run: ({ office, me }, { input }) => {
    if (office.where(input).get().length) {
      return { kind: "exists" as const, officeId: input.officeId };
    }

    office.set({ ...input, userId: me });
    return { kind: "created" as const, officeId: input.officeId };
  },
});

const addMember = operation({
  label: "member.add.do",
  input: roomApi["member.add"].input,
  depends: { office: members.controller, ok: inOffice },
  run: ({ office, ok }, { input }) => {
    if (!ok.run({ input })) return { kind: "gone" as const };

    office.set(input);
    return { kind: "added" as const };
  },
});

const addRoom = operation({
  label: "room.add.do",
  input: roomApi["room.add"].input,
  depends: { list: rooms.controller, ok: inOffice },
  run: ({ list, ok }, { input, random }) => {
    if (!ok.run({ input })) return { kind: "gone" as const };

    const roomId = random.uuid();
    list.set({ ...input, id: roomId });
    return { kind: "added" as const, roomId };
  },
});

/** A booking of one room on one day. `taken` when a booking of that room and day overlaps it:
 * the two spans `[start, end)` share a minute. */
const makeBooking = operation({
  label: "booking.make.do",
  input: roomApi["booking.make"].input,
  depends: { list: rooms.controller, book: bookings.controller, ok: inOffice, me: caller.required },
  run: ({ list, book, ok, me }, { input, random }) => {
    // The member check comes first, as in every call: nobody outside the office reaches a read.
    const { officeId, roomId, day, start, end } = input;
    const room = ok.run({ input }) ? list.of({ officeId, id: roomId }).get() : undefined;
    if (!room) return { kind: "gone" as const };
    const that = book.where({ officeId, roomId, day }).get();
    if (that.some((b) => b.start < end && start < b.end)) return { kind: "taken" as const };

    const id = random.uuid();
    book.set({ officeId, roomId, day, id, start, end, by: me });
    return { kind: "booked" as const, id };
  },
});

/** The server's side of `roomApi`, by address: `rooms.api({ implement: roomOps })`. */
export const roomOps = {
  "office.create": createOffice,
  "member.add": addMember,
  "room.add": addRoom,
  "booking.make": makeBooking,
} as const;
