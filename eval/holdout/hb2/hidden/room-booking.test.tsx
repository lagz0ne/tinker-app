import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { exits } from "@tinkered/cli/test";
import { createScope, operation, transport } from "@tinkered/core";
import type { Observe, Scope } from "@tinkered/core";
import { memory } from "@tinkered/core/testing";
import { ScopeProvider } from "@tinkered/react";
import { createRoot } from "react-dom/client";
import { expect, onTestFinished, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { rooms } from "@/rooms";
import { membersOnly, roomOps, signedIn } from "@/rooms/ops.server";
import { signIn, whoMeta } from "@/rooms/sign-in";
import { routeTree } from "@/routes";

// In a real Chromium: the booking pages over `memory`, with the app's own routes. Two tabs are
// two scopes; one is drawn, the other only calls.

const day = "2026-12-01";

/** A server as the cmds install it; a test may swap ops of the api. */
const serverOf = async (
  swap: Partial<typeof roomOps> = {},
  observe?: { export: (span: Observe.Span) => void },
) =>
  createScope({
    observe,
    capsules: [
      exits({ store: localStorage }),
      rooms.board({ serve: true, onStart: [signedIn, membersOnly] }),
      rooms.api({ implement: { ...roomOps, ...swap }, onStart: [signedIn] }),
      memory.server({ services: [rooms.board, rooms.api] }),
    ],
  }).ready;

/** A tab on `server`, signed in as `name` (no name: not signed in). */
const tabOf = async (server: Scope.Handle, name: string) => {
  const scope = await createScope({
    // The tab observes, as the real page does (`telemetry.browser`): a fault's ref is its trace.
    observe: { export: () => undefined },
    capsules: [
      exits({ store: localStorage }),
      memory.client({ peer: server, meta: whoMeta }),
      rooms.board({ read: memory.client }),
      rooms.api({ remote: memory.client }),
    ],
  }).ready;
  if (name) scope.run(signIn, { input: { name } });

  return scope;
};

/** Draws the app on `scope` at `path`; answers the history. */
const draw = (scope: Scope.Handle, path: string) => {
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createRouter({ routeTree, history, context: { scope } });
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  // A test that fails leaves no page behind for the next one.
  onTestFinished(() => root.unmount());
  root.render(
    <ScopeProvider scope={scope}>
      <RouterProvider router={router} />
    </ScopeProvider>,
  );

  return history;
};

/** Office HQ, made by `scope`'s person, with the rooms named; answers each room's id by name. */
const hq = async (scope: Scope.Handle, ...names: string[]) => {
  await scope.run(rooms.api["office.create"], { input: { officeId: "HQ" } });
  const ids: Record<string, string> = {};
  for (const name of names) {
    const added = await scope.run(rooms.api["room.add"], { input: { officeId: "HQ", name } });
    if (added.kind === "added") ids[name] = added.roomId;
  }
  return ids;
};

/** Fills the booking form and presses `Book`. */
const bookOnPage = async (room: string, start: string, end: string) => {
  await page.getByRole("combobox", { name: "Room", exact: true }).selectOptions(room);
  await page.getByLabelText("Start", { exact: true }).fill(start);
  await page.getByLabelText("End", { exact: true }).fill(end);
  await page.getByRole("button", { name: "Book", exact: true }).click();
};

/** The text of a room's region. */
const textOf = (room: string) =>
  page.getByRole("region", { name: room, exact: true }).element().textContent ?? "";

test("a booking made on one tab shows on the drawn tab; the form books a room", async () => {
  const server = await serverOf();
  const [ana, bo] = [await tabOf(server, "ana"), await tabOf(server, "bo")];
  const ids = await hq(ana, "Blue", "Green");
  await ana.run(rooms.api["member.add"], { input: { officeId: "HQ", userId: "bo" } });
  draw(bo, `/rooms/HQ/${day}`);

  await expect.element(page.getByRole("heading", { name: "HQ", exact: true })).toBeVisible();
  // P2: one region per room. In the page, not "visible": a region with no booking may have no size.
  for (const room of ["Blue", "Green"]) {
    await expect.element(page.getByRole("region", { name: room, exact: true })).toBeInTheDocument();
  }

  await bookOnPage("Green", "10:00", "11:00");
  await expect.poll(() => textOf("Green")).toContain("10:00-11:00 bo");
  expect(server.resolve(rooms.board.bookings).get()).toMatchObject([
    { officeId: "HQ", roomId: ids.Green, day, start: "10:00", end: "11:00", by: "bo" },
  ]);

  // A booking on the other tab shows here with no reload, in its room's region only.
  const slot = { officeId: "HQ", roomId: ids.Blue ?? "", day };
  await ana.run(rooms.api["booking.make"], { input: { ...slot, start: "11:00", end: "12:00" } });
  await expect.poll(() => textOf("Blue")).toContain("11:00-12:00 ana");
  expect(textOf("Green")).not.toContain("11:00-12:00");
  // A region lists its bookings by start; a booking of another day is not on this page.
  await ana.run(rooms.api["booking.make"], { input: { ...slot, start: "09:00", end: "10:00" } });
  await ana.run(rooms.api["booking.make"], {
    input: { ...slot, day: "2026-12-02", start: "13:00", end: "14:00" },
  });
  await expect.poll(() => textOf("Blue")).toContain("09:00-10:00 ana");
  const blue = textOf("Blue");
  expect(blue.indexOf("09:00-10:00 ana")).toBeLessThan(blue.indexOf("11:00-12:00 ana"));
  expect(document.body.textContent).not.toContain("13:00-14:00");

  await ana.close();
  await bo.close();
  await server.close();
});

// P1: the home page signs the person in and opens an office on a day. Nobody made the office
// before, so the page makes it: the day page that follows is read as a member.
test('"Open office" on a new key makes the office and shows its day', async () => {
  const server = await serverOf();
  const dee = await tabOf(server, "");
  const history = draw(dee, "/rooms");

  await page.getByLabelText("Your name", { exact: true }).fill("dee");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  // The server answers with the key it keeps (upper case), and the page opens the office there.
  await page.getByLabelText("Office key", { exact: true }).fill("new");
  await page.getByLabelText("Day", { exact: true }).fill(day);
  await page.getByRole("button", { name: "Open office", exact: true }).click();

  await expect.element(page.getByRole("heading", { name: "NEW", exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Book", exact: true })).toBeVisible();
  expect(history.location.pathname).toBe(`/rooms/NEW/${day}`);

  await dee.close();
  await server.close();
});

test('a tab that is not in the office sees why; "Try again" shows the office once it is in', async () => {
  const server = await serverOf();
  const cy = await tabOf(server, "cy");
  draw(cy, `/rooms/OPS/${day}`);

  await expect.element(page.getByRole("alert")).toBeVisible();

  await cy.run(rooms.api["office.create"], { input: { officeId: "OPS" } });
  await page.getByRole("button", { name: "Try again", exact: true }).click();

  await expect.element(page.getByRole("heading", { name: "OPS", exact: true })).toBeVisible();

  await cy.close();
  await server.close();
});

// P3: a read with no `who` is refused by `signedIn`: the page says to sign in.
test("a tab that is not signed in is told to sign in", async () => {
  const server = await serverOf();
  const nobody = await tabOf(server, "");
  draw(nobody, `/rooms/HQ/${day}`);

  await expect.element(page.getByRole("alert")).toBeVisible();
  expect(document.querySelector("form")).toBeNull();

  await nobody.close();
  await server.close();
});

// P3: until the server answers the reads, the page says that it loads, and shows no form. The
// server's read hook holds the reads here, so the wait is as long as the test needs.
test("a day that is not read yet says that it loads", async () => {
  const answer = Promise.withResolvers<void>();
  const hold = operation({
    label: "test.rooms.hold",
    input: transport.hook.start,
    run: async () => {
      await answer.promise;

      return undefined;
    },
  });
  const server = await createScope({
    capsules: [
      exits({ store: localStorage }),
      rooms.board({ serve: true, onStart: [signedIn, membersOnly, hold] }),
      rooms.api({ implement: roomOps, onStart: [signedIn] }),
      memory.server({ services: [rooms.board, rooms.api] }),
    ],
  }).ready;
  const ana = await tabOf(server, "ana");
  await hq(ana, "Blue");
  draw(ana, `/rooms/HQ/${day}`);

  await expect.element(page.getByRole("status")).toBeVisible();
  expect(document.querySelector("form")).toBeNull();

  answer.resolve();
  await expect.element(page.getByRole("heading", { name: "HQ", exact: true })).toBeVisible();

  await ana.close();
  await server.close();
});

// P2: an overlap in the same room answers taken. The page says so as a status; nothing is booked.
test("a taken room says so, and books nothing", async () => {
  const server = await serverOf();
  const ana = await tabOf(server, "ana");
  const ids = await hq(ana, "Blue");
  await ana.run(rooms.api["booking.make"], {
    input: { officeId: "HQ", roomId: ids.Blue ?? "", day, start: "09:00", end: "10:00" },
  });
  draw(ana, `/rooms/HQ/${day}`);
  await expect.poll(() => textOf("Blue")).toContain("09:00-10:00 ana");

  await bookOnPage("Blue", "09:30", "10:30");

  await expect.element(page.getByRole("status")).toBeVisible();
  expect(textOf("Blue")).not.toContain("09:30-10:30 ana");
  expect(server.resolve(rooms.board.bookings).get()).toHaveLength(1);

  await ana.close();
  await server.close();
});

// P2: `gone` is an answer, so the page says it as a status. The answer is replaced here: a member's
// own page gets `gone` only in a race (the room or the membership went away).
test("a booking that answers gone says so", async () => {
  const makeGone = operation({
    label: "test.booking.make.gone",
    input: rooms.api["booking.make"].input,
    run: () => ({ kind: "gone" as const }),
  });
  const server = await serverOf({ "booking.make": makeGone });
  const ana = await tabOf(server, "ana");
  await hq(ana, "Blue");
  draw(ana, `/rooms/HQ/${day}`);

  await bookOnPage("Blue", "09:00", "10:00");

  await expect.element(page.getByRole("status")).toBeVisible();

  await ana.close();
  await server.close();
});

// P4: a Cancel button on each booking of this tab's person, and on no other. A cancel takes the
// booking off the page; so does a cancel on another tab, with no reload.
test("Cancel shows on own bookings only; a cancel takes the booking off every tab", async () => {
  const server = await serverOf();
  const [ana, bo] = [await tabOf(server, "ana"), await tabOf(server, "bo")];
  const ids = await hq(ana, "Blue");
  await ana.run(rooms.api["member.add"], { input: { officeId: "HQ", userId: "bo" } });
  const slot = { officeId: "HQ", roomId: ids.Blue ?? "", day };
  await ana.run(rooms.api["booking.make"], { input: { ...slot, start: "09:00", end: "10:00" } });
  const bos = await bo.run(rooms.api["booking.make"], {
    input: { ...slot, start: "11:00", end: "12:00" },
  });
  draw(ana, `/rooms/HQ/${day}`);
  await expect.poll(() => textOf("Blue")).toContain("11:00-12:00 bo");

  const mine = page.getByRole("button", { name: "Cancel 09:00-10:00", exact: true });
  await expect.element(mine).toBeVisible();
  // One Cancel on the page: ana's. bo's booking has none.
  expect(
    page.getByRole("button", { name: /^Cancel \d\d:\d\d-\d\d:\d\d$/ }).elements(),
  ).toHaveLength(1);

  await mine.click();
  await expect.poll(() => textOf("Blue")).not.toContain("09:00-10:00");
  expect(
    server
      .resolve(rooms.board.bookings)
      .get()
      .map((b) => b.by),
  ).toEqual(["bo"]);

  await bo.run(rooms.api["booking.cancel"], {
    input: { officeId: "HQ", id: bos.kind === "booked" ? bos.id : "" },
  });
  await expect.poll(() => textOf("Blue")).not.toContain("11:00-12:00");

  await ana.close();
  await bo.close();
  await server.close();
});

// P4: `notYours` and `gone` are answers, so the page says them as a status. The answers are
// replaced here: a person's own Cancel gets them only in a race.
test("a cancel that answers notYours says so", async () => {
  const notYours = operation({
    label: "test.booking.cancel.notYours",
    input: rooms.api["booking.cancel"].input,
    run: () => ({ kind: "notYours" as const }),
  });
  const server = await serverOf({ "booking.cancel": notYours });
  const ana = await tabOf(server, "ana");
  const ids = await hq(ana, "Blue");
  await ana.run(rooms.api["booking.make"], {
    input: { officeId: "HQ", roomId: ids.Blue ?? "", day, start: "09:00", end: "10:00" },
  });
  draw(ana, `/rooms/HQ/${day}`);

  await page.getByRole("button", { name: "Cancel 09:00-10:00", exact: true }).click();

  await expect.element(page.getByRole("status")).toBeVisible();
  expect(textOf("Blue")).toContain("09:00-10:00 ana");

  await ana.close();
  await server.close();
});

test("a cancel that answers gone says so", async () => {
  const cancelGone = operation({
    label: "test.booking.cancel.gone",
    input: rooms.api["booking.cancel"].input,
    run: () => ({ kind: "gone" as const }),
  });
  const server = await serverOf({ "booking.cancel": cancelGone });
  const ana = await tabOf(server, "ana");
  const ids = await hq(ana, "Blue");
  await ana.run(rooms.api["booking.make"], {
    input: { officeId: "HQ", roomId: ids.Blue ?? "", day, start: "09:00", end: "10:00" },
  });
  draw(ana, `/rooms/HQ/${day}`);

  await page.getByRole("button", { name: "Cancel 09:00-10:00", exact: true }).click();

  await expect.element(page.getByRole("status")).toBeVisible();

  await ana.close();
  await server.close();
});

test("a call that breaks on the server shows a ref, and the server's trace has the cause", async () => {
  const spans: Observe.Span[] = [];
  const boom = operation({
    label: "booking.make.boom",
    input: rooms.api["booking.make"].input,
    run: (): { kind: "gone" } => {
      throw new Error("the disk is full");
    },
  });
  const server = await serverOf(
    { "booking.make": boom },
    {
      export: (span) => void spans.push(span),
    },
  );
  const ana = await tabOf(server, "ana");
  await hq(ana, "Blue");
  draw(ana, `/rooms/HQ/${day}`);

  await bookOnPage("Blue", "09:00", "10:00");
  await expect.element(page.getByRole("alert")).toBeVisible();

  const failed = spans.find((span) => span.name === "booking.make.boom");
  expect(page.getByRole("alert").element().textContent).toContain(failed?.traceId.slice(0, 8));
  expect(String(failed?.error)).toContain("the disk is full");

  await ana.close();
  await server.close();
});

// `link` on a read: the server goes away with the page open. Its close ends the open watch, so
// the part is a fault, and the page says so in place of the form. Core asks again by itself.
test("the server goes away with the page open: the page says that it is offline", async () => {
  const server = await serverOf();
  const ana = await tabOf(server, "ana");
  await hq(ana, "Blue");
  draw(ana, `/rooms/HQ/${day}`);
  await expect.element(page.getByRole("button", { name: "Book", exact: true })).toBeVisible();

  await server.close();

  await expect.element(page.getByRole("status")).toBeVisible();
  expect(document.querySelector("form")).toBeNull();
  // A broken link heals by itself: there is nothing for the person to press.
  expect([...document.querySelectorAll("button")].map((b) => b.textContent)).not.toContain(
    "Try again",
  );

  await ana.close();
});
