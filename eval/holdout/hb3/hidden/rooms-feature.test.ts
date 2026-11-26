import { exits } from "@tinkered/cli/test";
import { createScope } from "@tinkered/core";
import type { Observe, Scope } from "@tinkered/core";
import { afterAll, beforeEach, expect, test } from "vite-plus/test";

import { rooms } from "@/rooms";
import { membersOnly, roomOps, signedIn } from "@/rooms/ops.server";
import { signIn, whoMeta } from "@/rooms/sign-in";

import { listen, wsClient as tab, wsServer as server } from "./support/ws";

// Room booking as the cmds install it, over a real socket: the server serves each office's parts
// to its members and implements the api; each tab reads the board and calls the api. The `who`
// name in each message's meta stands in for sign-in. Both sides export their spans, so a test can
// follow one trace.

const serverSpans: Observe.Span[] = [];
const tabSpans: Observe.Span[] = [];

const backend = await createScope({
  observe: { export: (span) => void serverSpans.push(span) },
  capsules: [
    exits({ file: process.env.TINKER_EXITS }),
    rooms.board({ serve: true, onStart: [signedIn, membersOnly] }),
    rooms.api({ implement: roomOps, onStart: [signedIn] }),
    server.server({ path: "/rpc", services: [rooms.board, rooms.api] }),
  ],
}).ready;

const { bun, url } = listen(backend, [server.server]);
const tabs: Scope.Handle[] = [];

/** A tab signed in as `who`, its spans in `tabSpans`. */
const open = async (who: string) => {
  const scope = await createScope({
    observe: { export: (span) => void tabSpans.push(span) },
    capsules: [
      exits({ file: process.env.TINKER_EXITS }),
      tab.client({ url: `${url}/rpc`, meta: whoMeta }),
      rooms.board({ read: tab.client }),
      rooms.api({ remote: tab.client }),
    ],
  }).ready;
  if (who) scope.run(signIn, { input: { name: who } });
  tabs.push(scope);
  return scope;
};

const [ana, bo, cy] = [await open("ana"), await open("bo"), await open("cy")];
let n = 0;
const day = "2026-12-01";

/** A fresh office that ana made and bo joined, with one room; cy is not in it. */
const office = async () => {
  const officeId = `O${++n}`;
  await ana.run(rooms.api["office.create"], { input: { officeId } });
  await ana.run(rooms.api["member.add"], { input: { officeId, userId: "bo" } });
  const added = await ana.run(rooms.api["room.add"], { input: { officeId, name: "Blue" } });
  const roomId = added.kind === "added" ? added.roomId : "";

  return { officeId, roomId };
};

/** A tab's reader of one office's bookings on one day, kept in use: a keyed board serves only
 * parts in use. */
const read = (scope: Scope.Handle, officeId: string, on = day) => {
  const reader = scope.resolve(rooms.board.bookings.where({ officeId, day: on }));
  reader.watch(() => undefined);
  return reader;
};

/** The state of a tab's part of one office's bookings on `day`. */
const state = (scope: Scope.Handle, officeId: string) =>
  scope.resolve(rooms.board.status(rooms.board.bookings.where({ officeId, day }))).get()?.status;

/** Every booking the server holds. */
const stored = () => backend.resolve(rooms.board.bookings).get();

const until = async (ok: () => boolean) => {
  const end = Date.now() + 8000;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

beforeEach(() => {
  serverSpans.length = tabSpans.length = 0;
});

afterAll(async () => {
  for (const scope of tabs) await scope.close();
  await bun.stop(true);
  await backend.close();
});

// S1: the key is upper case, the maker is the first member, and `exists` is an answer, not a way
// in: a person outside the office who names its key is told that it exists, and stays outside.
test("an office is made once, in upper case; exists takes no new member", async () => {
  const officeId = `NEW${++n}`;

  expect(
    await ana.run(rooms.api["office.create"], { input: { officeId: officeId.toLowerCase() } }),
  ).toEqual({ kind: "created", officeId });
  expect(await cy.run(rooms.api["office.create"], { input: { officeId } })).toEqual({
    kind: "exists",
    officeId,
  });
  const inOffice = backend
    .resolve(rooms.board.members)
    .get()
    .filter((m) => m.officeId === officeId)
    .map((m) => m.userId);
  expect(inOffice).toEqual(["ana"]);
  expect(await cy.run(rooms.api["room.add"], { input: { officeId, name: "Red" } })).toEqual({
    kind: "gone",
  });
});

// S2: a room is added to an office; every member's tab that reads the office's rooms sees it.
test("a room added on one tab shows in the rooms of the other tab", async () => {
  const { officeId } = await office();
  const seen = bo.resolve(rooms.board.rooms.where({ officeId }));
  seen.watch(() => undefined);
  await until(() => seen.get().length === 1);

  const added = await ana.run(rooms.api["room.add"], { input: { officeId, name: "Green" } });

  expect(added).toEqual({ kind: "added", roomId: expect.any(String) });
  await until(() => seen.get().length === 2);
  const green = seen.get().find((r) => r.name === "Green");
  expect(green).toMatchObject({ officeId, id: added.kind === "added" ? added.roomId : "" });
});

// S3 and S4: a booking lands on every member's tab; an overlap in the same room on the same day
// answers taken, and writes nothing. The booker is the caller.
test("a booking lands on the other tab; an overlap of the same room and day answers taken", async () => {
  const { officeId, roomId } = await office();
  const seen = read(bo, officeId);
  const book = (scope: Scope.Handle, start: string, end: string, more = {}) =>
    scope.run(rooms.api["booking.make"], {
      input: { officeId, roomId, day, start, end, ...more },
    });

  const first = await book(ana, "09:00", "10:00");
  expect(first).toEqual({ kind: "booked", id: expect.any(String) });
  await until(() => seen.get().length === 1);
  expect(seen.get()[0]).toEqual({
    officeId,
    roomId,
    day,
    id: first.kind === "booked" ? first.id : "",
    start: "09:00",
    end: "10:00",
    by: "ana",
  });

  const taken = { kind: "taken" };
  expect(await book(bo, "09:30", "10:30")).toEqual(taken);
  expect(await book(bo, "08:00", "11:00")).toEqual(taken);
  expect(await book(bo, "09:15", "09:45")).toEqual(taken);
  expect(await book(bo, "09:00", "10:00")).toEqual(taken);
  expect(stored().filter((b) => b.officeId === officeId)).toHaveLength(1);

  // A span ends before its end: a booking may start when the other one ends.
  expect(await book(bo, "10:00", "11:00")).toMatchObject({ kind: "booked" });
  expect(await book(bo, "08:00", "09:00")).toMatchObject({ kind: "booked" });
  // The same time is free in another room, and in the same room on another day.
  const other = await ana.run(rooms.api["room.add"], { input: { officeId, name: "Green" } });
  const roomB = other.kind === "added" ? other.roomId : "";
  expect(await book(bo, "09:00", "10:00", { roomId: roomB })).toMatchObject({ kind: "booked" });
  expect(await book(bo, "09:00", "10:00", { day: "2026-12-02" })).toMatchObject({
    kind: "booked",
  });

  await until(() => seen.get().length === 4);
  expect(
    seen
      .get()
      .filter((b) => b.by === "bo")
      .map((b) => `${b.start}-${b.end}`)
      .toSorted(),
  ).toEqual(["08:00-09:00", "09:00-10:00", "10:00-11:00"]);
});

test("a tab with no `who` is refused; so is a member of no office, on calls and on reads", async () => {
  const { officeId, roomId } = await office();
  const peek = read(cy, officeId);
  const ghost = await open("");
  await ana.run(rooms.api["booking.make"], {
    input: { officeId, roomId, day, start: "09:00", end: "10:00" },
  });

  expect(
    await cy.run(rooms.api["booking.make"], {
      input: { officeId, roomId, day, start: "11:00", end: "12:00" },
    }),
  ).toEqual({ kind: "gone" });
  const refused = await ghost
    .run(rooms.api["office.create"], { input: { officeId: "NOPE" } })
    .catch((e: unknown) => e);
  expect(rooms.api.fault.is(refused) && refused.fault).toBe("refused");
  await until(() => state(cy, officeId) === "fault");
  expect(peek.get()).toEqual([]);
});

/** Reads each part of one office on a tab; answers a function that gives each part's fault. */
const faultsOf = (scope: Scope.Handle, officeId: string) => {
  const members = rooms.board.members.where({ officeId });
  const list = rooms.board.rooms.where({ officeId });
  const booked = rooms.board.bookings.where({ officeId, day });
  scope.resolve(members).watch(() => undefined);
  scope.resolve(list).watch(() => undefined);
  scope.resolve(booked).watch(() => undefined);

  return () =>
    [
      scope.resolve(rooms.board.status(members)).get(),
      scope.resolve(rooms.board.status(list)).get(),
      scope.resolve(rooms.board.status(booked)).get(),
    ].map((now) => (now?.status === "fault" ? now.fault : undefined));
};

// S5, each part of an office: members, rooms and bookings. A read from outside the office is
// refused with the office in the payload; a read with no `who` is refused too.
test("every part of an office is refused to a person outside it, and to a tab with no `who`", async () => {
  const { officeId, roomId } = await office();
  await ana.run(rooms.api["booking.make"], {
    input: { officeId, roomId, day, start: "09:00", end: "10:00" },
  });
  const outside = faultsOf(cy, officeId);
  const nobody = faultsOf(await open(""), officeId);
  await until(() => [...outside(), ...nobody()].every(Boolean));

  const refused = { fault: "refused", payload: { notMember: officeId } };
  expect(outside()).toMatchObject([refused, refused, refused]);
  expect(nobody().map((fault) => fault?.fault)).toEqual(["refused", "refused", "refused"]);
});

// S5, each call that names an office: `gone` from outside the office, and for a room the office
// does not have. Nothing is written.
test("every call that names an office answers gone to a person outside it, and writes nothing", async () => {
  const { officeId, roomId } = await office();
  const slot = { officeId, roomId, day, start: "09:00", end: "10:00" };
  const gone = { kind: "gone" };

  expect(await cy.run(rooms.api["member.add"], { input: { officeId, userId: "cy" } })).toEqual(
    gone,
  );
  expect(await cy.run(rooms.api["room.add"], { input: { officeId, name: "Mine" } })).toEqual(gone);
  expect(await cy.run(rooms.api["booking.make"], { input: slot })).toEqual(gone);
  serverSpans.length = 0;
  expect(await ana.run(rooms.api["booking.make"], { input: { ...slot, roomId: "none" } })).toEqual(
    gone,
  );
  // S7: each call runs the member check, also when its room is not there.
  await until(() => serverSpans.filter((span) => span.name === "rooms.inOffice").length === 1);
  // A room of another office is not a room of this one.
  const other = await office();
  expect(
    await ana.run(rooms.api["booking.make"], { input: { ...slot, roomId: other.roomId } }),
  ).toEqual(gone);

  const members = backend.resolve(rooms.board.members).get();
  expect(members.some((m) => m.officeId === officeId && m.userId === "cy")).toBe(false);
  expect(
    backend
      .resolve(rooms.board.rooms)
      .get()
      .filter((r) => r.officeId === officeId)
      .map((r) => r.name),
  ).toEqual(["Blue"]);
  expect(stored().filter((b) => b.officeId === officeId || b.officeId === other.officeId)).toEqual(
    [],
  );
});

// S8: a booking is cancelled by its booker alone. Another member gets notYours, a person outside
// the office and an unknown booking get gone; none of them writes anything.
test("a booking is cancelled by its booker alone; notYours and gone write nothing", async () => {
  const { officeId, roomId } = await office();
  const seen = read(bo, officeId);
  const slot = { officeId, roomId, day, start: "09:00", end: "10:00" };
  const made = await ana.run(rooms.api["booking.make"], { input: slot });
  const id = made.kind === "booked" ? made.id : "";
  await until(() => seen.get().length === 1);
  const cancel = (scope: Scope.Handle, input = { officeId, id }) =>
    scope.run(rooms.api["booking.cancel"], { input });

  expect(await cancel(bo)).toEqual({ kind: "notYours" });
  expect(await cancel(cy)).toEqual({ kind: "gone" });
  serverSpans.length = 0;
  expect(await cancel(ana, { officeId, id: "none" })).toEqual({ kind: "gone" });
  // Each call runs the member check, also when its booking is not there.
  await until(() => serverSpans.filter((span) => span.name === "rooms.inOffice").length === 1);
  // A booking is found by office and id: in another office of ana's it is not there.
  const other = await office();
  expect(await cancel(ana, { officeId: other.officeId, id })).toEqual({ kind: "gone" });
  expect(stored().filter((b) => b.id === id)).toHaveLength(1);

  expect(await cancel(ana)).toEqual({ kind: "cancelled" });
  // The cancel shows on the other tab with no reload, and the time is free again.
  await until(() => seen.get().length === 0);
  expect(stored().filter((b) => b.officeId === officeId)).toEqual([]);
  expect(await cancel(ana)).toEqual({ kind: "gone" });
  expect(await bo.run(rooms.api["booking.make"], { input: slot })).toMatchObject({
    kind: "booked",
  });
});

// S9: a person reads their own bookings by `by`, in or out of the office. Another person's
// bookings, by part or by whole key, take the office check.
test("a person reads their own bookings by `by`; another person's take the office check", async () => {
  const { officeId, roomId } = await office();
  const slot = { officeId, roomId, day, start: "09:00", end: "10:00" };
  const made = await ana.run(rooms.api["booking.make"], { input: slot });
  await bo.run(rooms.api["booking.make"], { input: { ...slot, start: "11:00", end: "12:00" } });
  const watch = (scope: Scope.Handle, part: Parameters<typeof rooms.board.bookings.where>[0]) => {
    const reader = scope.resolve(rooms.board.bookings.where(part));
    reader.watch(() => undefined);
    const status = scope.resolve(rooms.board.status(rooms.board.bookings.where(part)));

    return { rows: () => reader.get(), now: () => status.get() };
  };

  const anas = watch(ana, { officeId, by: "ana" });
  await until(() => anas.now()?.status === "ready");
  expect(anas.rows().map((b) => `${b.start} ${b.by}`)).toEqual(["09:00 ana"]);
  // A new booking of ana's, on another day, shows in that part with no reload.
  await ana.run(rooms.api["booking.make"], { input: { ...slot, day: "2026-12-02" } });
  await until(() => anas.rows().length === 2);
  // A member reads another member's bookings: the office check lets them.
  const bosView = watch(bo, { officeId, by: "ana" });
  await until(() => bosView.rows().length === 2);

  // cy is in no office of ana's, yet reads cy's own rows, here and in every office.
  const own = watch(cy, { officeId, by: "cy" });
  const everywhere = watch(cy, { by: "cy" });
  await until(() => own.now()?.status === "ready" && everywhere.now()?.status === "ready");
  expect(own.rows()).toEqual([]);
  // ana's rows go to cy neither by part nor by whole key.
  const peek = watch(cy, { officeId, by: "ana" });
  const id = made.kind === "booked" ? made.id : "";
  const row = cy.resolve(rooms.board.bookings.of({ officeId, roomId, day, by: "ana", id }));
  row.watch(() => undefined);
  const rowState = cy.resolve(
    rooms.board.status(rooms.board.bookings.of({ officeId, roomId, day, by: "ana", id })),
  );
  await until(() => peek.now()?.status === "fault" && rowState.get()?.status === "fault");
  const refused = { fault: "refused", payload: { notMember: officeId } };
  expect(peek.now()).toMatchObject({ fault: refused });
  expect(rowState.get()).toMatchObject({ fault: refused });
  expect(peek.rows()).toEqual([]);
});

// A refused part is the server's answer: the tab does not ask again by itself. The page's
// "Try again" is an `invalidate` of the part, as a query's `refetch`.
test("a person added while their tab is open sees the office when they try again", async () => {
  const { officeId, roomId } = await office();
  const peek = read(cy, officeId);
  await ana.run(rooms.api["booking.make"], {
    input: { officeId, roomId, day, start: "09:00", end: "10:00" },
  });
  await until(() => state(cy, officeId) === "fault");

  await ana.run(rooms.api["member.add"], { input: { officeId, userId: "cy" } });
  await cy.run(rooms.board.invalidate, { input: { bookings: { officeId, day } } });
  await until(() => peek.get().length === 1);

  expect(state(cy, officeId)).toBe("ready");
});

/** The one span of this name; its trace id. */
const one = (spans: Observe.Span[], name: string) => {
  const found = spans.filter((span) => span.name === name);
  expect(found).toHaveLength(1);
  return found[0]!;
};

// One booking, followed across both tabs and the server, as OTel messaging: tab A's call, the
// server's op and its `remoteData.send` (the producer) are one trace. Tab B's ask runs under
// `remoteData.receive` (the consumer), a trace of its own with a link to the send.
test("one booking: one trace from tab A to the server's send; tab B's ask links to it", async () => {
  const { officeId, roomId } = await office();
  const seen = read(bo, officeId);
  await until(() => state(bo, officeId) === "ready");
  serverSpans.length = tabSpans.length = 0;

  await ana.run(rooms.api["booking.make"], {
    input: { officeId, roomId, day, start: "09:00", end: "10:00" },
  });
  await until(() => seen.get().length === 1);
  await until(() => serverSpans.some((s) => s.name === "remoteData.answer"));

  const names = (spans: Observe.Span[], traceId: string) =>
    spans
      .filter((s) => s.traceId === traceId)
      .map((s) => s.name)
      .toSorted();
  const call = one(tabSpans, "booking.make").traceId;
  const send = one(serverSpans, "remoteData.send");
  const receive = one(tabSpans, "remoteData.receive");
  const ask = receive.traceId;

  expect(names(tabSpans, call)).toEqual(["booking.make", "rooms.whoMeta", "ws.call", "ws.send"]);
  // An op of the writer's own that the call runs may be there too.
  expect(names(serverSpans, call)).toEqual(
    expect.arrayContaining([
      "booking.make.do",
      "remoteData.send",
      "rooms.inOffice",
      "rooms.signedIn",
      "rpc.answer",
      "ws.serve",
    ]),
  );
  expect(names(serverSpans, call)).not.toContain("rooms.membersOnly");
  expect(send.traceId).toBe(call);
  const link = receive.events.find((e) => e.name === "link")?.attributes?.traceparent;
  expect(link).toBe(`00-${call}-${send.spanId}-01`);
  expect(names(tabSpans, ask)).toEqual([
    "bookings.ask",
    "remoteData.receive",
    "rooms.whoMeta",
    "ws.call",
    "ws.send",
  ]);
  expect(names(serverSpans, ask)).toEqual(
    expect.arrayContaining([
      "remoteData.answer",
      "remoteData.ask",
      "rooms.inOffice",
      "rooms.membersOnly",
      "rooms.signedIn",
      "ws.serve",
    ]),
  );
});
