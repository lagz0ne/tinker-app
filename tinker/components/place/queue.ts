import { resource } from "@tinkered/core";

import { placeLeaving } from "./place";

/**
 * How long a leave waits for the move its walk asks for: a browser that drops it (a swipe cancelled, an entry
 * replaced, a history a test walks by hand) must not hold the page, so the wait gives up and the next Back is a Back
 * again.
 */
const POP_GIVE_UP_MS = 600;

/**
 * The page's one navigation queue: a push waits until the move a leave is waiting for has come (or its wait has given
 * up), so two navigations never race for the same history entry. The wait is armed *before* the walk, so a history
 * that answers at once cannot slip past it, and it carries the page's own clock (`ctx.clock`), so a test moves the
 * 600 ms by hand.
 */
export const placeQueue = resource({
  label: "place.queue",
  target: "session",
  depends: { leaving: placeLeaving.controller },
  factory: ({ leaving }, { defer, clock, signal }) => {
    let tail: Promise<unknown> = Promise.resolve();
    let waiting: (() => void) | null = null;

    const settle = () => {
      const done = waiting;

      waiting = null;
      if (done !== null) done();
    };

    const enqueue = async (task: () => Promise<void>) => {
      tail = tail.then(task, task);
      await tail;
    };

    const pop = async (walk: () => void) => {
      const moved = new Promise<void>((resolve) => {
        waiting = resolve;
      });

      walk();
      await Promise.race([moved, clock.sleep(POP_GIVE_UP_MS, signal).catch(() => undefined)]);
      // The move came (its `settle` already ran) or the wait gave up: either way the leave is over.
      settle();
      leaving.set(false);
    };

    defer(settle);

    return { enqueue, pop, moved: settle };
  },
});
