import { operation } from "@tinker/core";
import { z } from "zod";

import {
  placeAddress,
  placeLeaving,
  placeName,
  placeNow,
  placeRouter,
  placeSearch,
  placeStack,
} from "./place";
import { placeQueue } from "./queue";

/**
 * What the address says now: the place its search names (`null` when it names none) and the places the open entry
 * carries in its own state. A reload reads both back.
 */
export const placeRead = operation({
  label: "place.read",
  depends: { address: placeAddress.required },
  run: ({ address }): { place: string | null; stack: string[] } => {
    const named = placeSearch.safeParse(
      Object.fromEntries(new URLSearchParams(address.location.search)),
    );
    const state: unknown = address.location.state;
    const held = z
      .array(placeName)
      .safeParse(
        typeof state === "object" && state !== null && "places" in state ? state.places : [],
      );

    return {
      place: named.success ? (named.data.place ?? null) : null,
      stack: held.success ? held.data : [],
    };
  },
});

/** Write the place and the screens the address names: the page's one writer of both cells. */
export const placeWrite = operation({
  label: "place.write",
  input: z.object({ place: placeName.nullable(), stack: z.array(placeName) }),
  depends: { place: placeNow.controller, stack: placeStack.controller },
  run: ({ place, stack }, { input }) => {
    place.set(input.place);
    stack.set(input.stack);
  },
});

/**
 * The page's one navigation: open a place through the router, with the screens behind it on the entry, then read the
 * address back into the cells. `replace` rewrites the open entry instead of pushing one: an outside steer is not a
 * move a person made, so it leaves no entry of its own to close.
 */
export const placeNavigate = operation({
  label: "place.navigate",
  input: z.object({ place: placeName, stack: z.array(placeName), replace: z.boolean() }),
  depends: {
    address: placeAddress.required,
    router: placeRouter.required,
    read: placeRead.controller,
    write: placeWrite.controller,
  },
  run: async ({ address, router, read, write }, { input }) => {
    const state = { ...address.location.state, places: input.stack };

    await router.navigate({
      to: ".",
      search: { place: input.place },
      state,
      replace: input.replace,
    });

    write.run({ input: read.run() });
  },
});

/**
 * A person goes to a place: one entry, one screen behind it. It waits in the page's queue, so a push never races the
 * move a leave is waiting for, and going to the place the page already shows is no move at all.
 */
export const placeGo = operation({
  label: "place.go",
  input: placeName,
  depends: {
    place: placeNow.controller,
    stack: placeStack.controller,
    queue: placeQueue,
    open: placeNavigate.controller,
  },
  run: async ({ place, stack, queue, open }, { input }) => {
    await queue.enqueue(async () => {
      if (place.get() === input) return;

      await open.run({ input: { place: input, stack: [...stack.get(), input], replace: false } });
    });
  },
});

/**
 * An outside view asks the page to show a place (`set view`): the same navigation, with the screens the open entry
 * already carries, and no entry of its own, so Back is never asked to close a screen nobody pushed.
 */
export const placeSetView = operation({
  label: "place.setView",
  input: placeName,
  depends: {
    place: placeNow.controller,
    stack: placeStack.controller,
    queue: placeQueue,
    open: placeNavigate.controller,
  },
  run: async ({ place, stack, queue, open }, { input }) => {
    await queue.enqueue(async () => {
      if (place.get() === input) return;

      await open.run({ input: { place: input, stack: [...stack.get()], replace: true } });
    });
  },
});

/**
 * Leave every screen at once: one walk back over the pushes the stack counts, and a wait for the move it brings. The
 * wait gives up after 600 ms (`./queue.ts`), so a move the browser drops cannot hold the page.
 */
export const placeLeave = operation({
  label: "place.leave",
  depends: {
    stack: placeStack.controller,
    leaving: placeLeaving.controller,
    address: placeAddress.required,
    read: placeRead.controller,
    write: placeWrite.controller,
    queue: placeQueue,
  },
  run: async ({ stack, leaving, address, read, write, queue }) => {
    await queue.enqueue(async () => {
      const screens = stack.get();

      if (screens.length === 0) return;

      leaving.set(true);
      await queue.pop(() => address.go(-screens.length));

      write.run({ input: read.run() });
    });
  },
});

/**
 * The browser walked to another entry: settle the move a leave is waiting for, then read the entry's own address and
 * state into the cells, so the page is where the browser is and no dead entry is walked.
 */
export const placeMoved = operation({
  label: "place.moved",
  depends: { read: placeRead.controller, write: placeWrite.controller, queue: placeQueue },
  run: ({ read, write, queue }) => {
    queue.moved();
    write.run({ input: read.run() });
  },
});

/**
 * Take a link's one-time params (`names`) out of the address once the page has used them: the link wins once, and a
 * later open reads the person's own choice instead. The address keeps the place the page opened (`place`, when the
 * caller has one to name), so a reload still lands there, and the router's own entry state rides along, so the page
 * is not read again. A replace, not a push: the entry is the one the link opened.
 */
export const placeClean = operation({
  label: "place.clean",
  input: z.object({ names: z.array(placeName), place: placeName.optional() }),
  depends: {
    address: placeAddress.required,
    read: placeRead.controller,
    write: placeWrite.controller,
  },
  run: ({ address, read, write }, { input }) => {
    const query = new URLSearchParams(address.location.search);
    const held = input.names.filter((name) => query.has(name));

    if (held.length === 0) return;

    for (const name of held) query.delete(name);
    if (input.place !== undefined) query.set("place", input.place);

    const search = query.toString();

    address.replace(
      `${address.location.pathname}${search === "" ? "" : `?${search}`}${address.location.hash}`,
      address.location.state,
    );

    write.run({ input: read.run() });
  },
});
