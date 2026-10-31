import { createScope } from "@tinker/core";
import { makeTestClock } from "@tinker/core/testing";
import { expect, test } from "vite-plus/test";

import { accountNotice } from "~/components/sync-sqlite/notice";
import { notifications } from "~/components/sync-sqlite/notifications.server";
import type { Stream } from "~/components/sync-sqlite/protocol";

import { listenOnly } from "./fixtures/sync-sqlite";

const cursor: Stream.Cursor = { public: 0, private: null };
const frame: Stream.Frame = { cursor, count: 0, bytes: new Uint8Array() };

/** A listener that never wakes and closes quietly. */
const quiet = listenOnly(async () => () => {});

/** Settle every queued promise step, so a wait that should stay pending is seen pending. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

test("closing one subscriber retains shared reads; closing the last removes them", async () => {
  let reads = 0;
  const root = createScope({ presets: [quiet] });

  await root.ready;
  const feed = await root.resolve(notifications);
  const first = await feed.subscribe();
  const second = await feed.subscribe();
  const read = async ({ input }: { input: Stream.Cursor }) => {
    expect(input).toBe(cursor);
    reads++;
    return { status: "success" as const, value: frame };
  };

  const held = feed.share("public:0", read, cursor);
  expect(await held).toBe(frame);
  feed.close(first);
  expect(feed.share("public:0", read, cursor)).toBe(held);
  feed.close(second);
  expect(await feed.share("public:0", read, cursor)).toBe(frame);
  expect(reads).toBe(2);
  await root.close({ graceful: true });
});

test("an old failed read cannot clear a newer wake's successful cached frame", async () => {
  let heard: (text: string) => void = () => {};
  const root = createScope({
    presets: [
      listenOnly(async (_channel, wake) => {
        heard = wake;
        return () => {};
      }),
    ],
  });

  await root.ready;
  const feed = await root.resolve(notifications);
  await feed.subscribe();
  const refused = Promise.withResolvers<never>();
  const old = feed.share("key", () => refused.promise, cursor);

  heard("saved");
  let reads = 0;
  const read = async () => {
    reads++;
    return { status: "success" as const, value: frame };
  };
  const current = feed.share("key", read, cursor);
  expect(await current).toBe(frame);
  const error = new Error("old read failed");
  refused.reject(error);
  await expect(old).rejects.toBe(error);
  expect(feed.share("key", read, cursor)).toBe(current);
  expect(reads).toBe(1);
  await root.close({ graceful: true });
});

test("account notices affect only that account and preserve the shared public wake", async () => {
  let heard: (text: string) => void = () => {};
  const root = createScope({
    presets: [
      listenOnly(async (_channel, wake) => {
        heard = wake;
        return () => {};
      }),
    ],
  });

  await root.ready;
  const feed = await root.resolve(notifications);
  const ada = await feed.subscribe(undefined, "Ada");
  const grace = await feed.subscribe(undefined, "Grace");
  const adaWait = feed.wait(ada, 0);
  const graceWait = feed.wait(grace, 0);

  const held = feed.share("public", async () => ({ status: "success", value: frame }), cursor);
  heard(root.run(accountNotice, { input: "Ada" }));
  expect(await adaWait).toBe(false);
  expect(ada.stale).toBe(true);
  expect(grace.stale).toBe(false);
  expect(feed.revision()).toBe(0);
  expect(
    feed.share(
      "public",
      () => {
        throw new Error("cache lost");
      },
      cursor,
    ),
  ).toBe(held);

  heard("saved");
  expect(await graceWait).toBe(false);
  expect(feed.revision()).toBe(1);
  feed.close(ada);
  feed.close(grace);
  await root.close({ graceful: true });
});

test("a replaced timer cannot erase the next timer; leases survive a wheel-slot wrap", async () => {
  const clock = makeTestClock();
  const durations: number[] = [];
  const root = createScope({
    clock: {
      ...clock,
      sleep: (ms, signal) => {
        durations.push(ms);
        return clock.sleep(ms, signal);
      },
    },
    presets: [quiet],
  });

  await root.ready;
  const feed = await root.resolve(notifications);
  const first = await feed.subscribe();
  const second = await feed.subscribe();

  const ended = feed.wait(first, 0, 30_000);
  feed.close(first);
  expect(await ended).toBe(false);
  const next = feed.wait(second, 0, 30_000);
  clock.advance(10_000);
  expect(await next).toBe(true);
  const again = feed.wait(second, 0, 30_000);
  clock.advance(10_000);
  expect(await again).toBe(true);
  expect(durations).toEqual([10_000, 10_000, 10_000]);
  feed.close(second);
  expect((await root.close({ graceful: true })).teardownErrors).toBeUndefined();
});

test("clock failure rejects all held waits and a later wait gets a fresh timer", async () => {
  const clock = makeTestClock();
  const fault = Promise.withResolvers<void>();
  let sleeps = 0;
  const root = createScope({
    clock: {
      ...clock,
      sleep: (ms, signal) => {
        sleeps++;
        return sleeps === 1 ? fault.promise : clock.sleep(ms, signal);
      },
    },
    presets: [quiet],
  });

  await root.ready;
  const feed = await root.resolve(notifications);
  const first = await feed.subscribe();
  const second = await feed.subscribe();
  const error = new Error("clock failed");
  const waits = [feed.wait(first, 0, 30_000), feed.wait(second, 0, 30_000)];
  const caught = Promise.all(waits.map((wait) => expect(wait).rejects.toBe(error)));
  fault.reject(error);
  await caught;
  const again = feed.wait(first, 0, 30_000);
  clock.advance(10_000);
  expect(await again).toBe(true);
  expect(sleeps).toBe(2);
  feed.close(first);
  feed.close(second);
  expect((await root.close({ graceful: true })).teardownErrors).toBeUndefined();
});

test("a failed listener is replaced once, disconnects its old subscribers, and closes the new connection on root exit", async () => {
  const broken: (() => void)[] = [];
  const closed: number[] = [];
  const root = createScope({
    presets: [
      listenOnly(async (_channel, _heard, fail) => {
        const id = broken.push(fail);
        return () => {
          closed.push(id);
        };
      }),
    ],
  });

  await root.ready;
  const feed = await root.resolve(notifications);
  let disconnected = 0;
  const first = await feed.subscribe(() => {
    disconnected++;
  });
  const waiting = feed.wait(first, 0);
  broken[0]!();
  expect(await waiting).toBe(false);
  expect(feed.ended(first)).toBe(true);
  const second = await feed.subscribe();
  expect(feed.ended(second)).toBe(false);
  expect(closed).toEqual([1]);
  feed.close(first);
  await root.close({ graceful: true });
  expect(disconnected).toBeGreaterThanOrEqual(1);
  expect(closed).toEqual([1, 2]);
});

test("a listener that cannot start fails the subscribe with its own error", async () => {
  const error = new Error("listen refused");
  const root = createScope({
    presets: [
      listenOnly(async () => {
        throw error;
      }),
    ],
  });

  await root.ready;
  const feed = await root.resolve(notifications);

  await expect(feed.subscribe()).rejects.toBe(error);
  expect((await root.close({ graceful: true })).teardownErrors).toBeUndefined();
});

test("a root that never subscribed closes without a listener to close", async () => {
  const root = createScope({ presets: [quiet] });

  await root.ready;
  await root.resolve(notifications);

  expect((await root.close({ graceful: true })).teardownErrors).toBeUndefined();
});

test("root exit disconnects a held subscriber, ends it, and releases its wait", async () => {
  const root = createScope({ presets: [quiet] });

  await root.ready;
  const feed = await root.resolve(notifications);
  let disconnected = 0;
  const held = await feed.subscribe(() => {
    disconnected++;
  });
  const waiting = feed.wait(held, 0);

  expect((await root.close({ graceful: true })).teardownErrors).toBeUndefined();
  expect(await waiting).toBe(false);
  expect(disconnected).toBe(1);
  expect(feed.ended(held)).toBe(true);
  expect(feed.wait(held, 0)).toBe(false);
});

test("waiting again on one subscriber keeps the one shared timer", async () => {
  const clock = makeTestClock();
  const durations: number[] = [];
  const root = createScope({
    clock: {
      ...clock,
      sleep: (ms, signal) => {
        durations.push(ms);
        return clock.sleep(ms, signal);
      },
    },
    presets: [quiet],
  });

  await root.ready;
  const feed = await root.resolve(notifications);
  const only = await feed.subscribe();

  void feed.wait(only, 0, 30_000);
  const latest = feed.wait(only, 0, 30_000);

  expect(durations).toEqual([10_000]);
  clock.advance(10_000);
  expect(await latest).toBe(true);
  await settled();

  // The fired wait left the wheel empty, so no further sleep starts.
  expect(durations).toEqual([10_000]);
  feed.close(only);
  expect((await root.close({ graceful: true })).teardownErrors).toBeUndefined();
});

test("closing one leased subscriber leaves the other's timer running", async () => {
  const clock = makeTestClock();
  const root = createScope({ clock, presets: [quiet] });

  await root.ready;
  const feed = await root.resolve(notifications);
  const first = await feed.subscribe();
  const second = await feed.subscribe();

  const dropped = feed.wait(first, 0, 30_000);
  const kept = feed.wait(second, 0, 30_000);

  feed.close(first);
  expect(await dropped).toBe(false);
  clock.advance(10_000);
  expect(await kept).toBe(true);
  feed.close(second);
  expect((await root.close({ graceful: true })).teardownErrors).toBeUndefined();
});

test("a wake takes the subscriber off the timer, so a later unleased wait never times out", async () => {
  let heard: (text: string) => void = () => {};
  const clock = makeTestClock();
  const root = createScope({
    clock,
    presets: [
      listenOnly(async (_channel, wake) => {
        heard = wake;
        return () => {};
      }),
    ],
  });

  await root.ready;
  const feed = await root.resolve(notifications);
  const only = await feed.subscribe();
  const leased = feed.wait(only, 0, 30_000);

  heard("saved");
  expect(await leased).toBe(false);

  let woke: boolean | undefined;
  const unleased = feed.wait(only, 1);

  if (unleased !== false) void unleased.then((value) => (woke = value));
  clock.advance(10_000);
  await settled();

  expect(unleased).not.toBe(false);
  expect(woke).toBeUndefined();
  feed.close(only);
  await settled();
  expect(woke).toBe(false);
  await root.close({ graceful: true });
});

test("root exit stops a pending wheel sleep", async () => {
  const clock = makeTestClock();
  const signals: (AbortSignal | undefined)[] = [];
  const root = createScope({
    clock: {
      ...clock,
      sleep: (ms, signal) => {
        signals.push(signal);
        return clock.sleep(ms, signal);
      },
    },
    presets: [quiet],
  });

  await root.ready;
  const feed = await root.resolve(notifications);
  const only = await feed.subscribe();

  void feed.wait(only, 0, 30_000);
  expect(signals.map((signal) => signal?.aborted)).toEqual([false]);

  expect((await root.close({ graceful: true })).teardownErrors).toBeUndefined();
  expect(signals.map((signal) => signal?.aborted)).toEqual([true]);
});

test("a wait on a stale, closed, or behind subscriber returns at once", async () => {
  const root = createScope({ presets: [quiet] });

  await root.ready;
  const feed = await root.resolve(notifications);
  const behind = await feed.subscribe();
  const stale = await feed.subscribe();
  const closed = await feed.subscribe();

  stale.stale = true;
  feed.close(closed);

  expect(feed.wait(behind, 1)).toBe(false);
  expect(feed.wait(stale, 0)).toBe(false);
  expect(feed.wait(closed, 0)).toBe(false);
  expect(feed.ended(closed)).toBe(true);
  expect(feed.ended(behind)).toBe(false);
  feed.close(behind);
  feed.close(stale);
  await root.close({ graceful: true });
});

test("the wheel sleeps again only until the next held deadline", async () => {
  const clock = makeTestClock();
  const durations: number[] = [];
  const root = createScope({
    clock: {
      ...clock,
      sleep: (ms, signal) => {
        durations.push(ms);
        return clock.sleep(ms, signal);
      },
    },
    presets: [quiet],
  });

  await root.ready;
  const feed = await root.resolve(notifications);
  const early = await feed.subscribe();
  const late = await feed.subscribe();

  const first = feed.wait(early, 0, 30_000);

  clock.advance(4_000);

  const second = feed.wait(late, 0, 30_000);

  clock.advance(6_000);
  expect(await first).toBe(true);
  await settled();
  expect(durations).toEqual([10_000, 4_000]);

  clock.advance(4_000);
  expect(await second).toBe(true);
  feed.close(early);
  feed.close(late);
  expect((await root.close({ graceful: true })).teardownErrors).toBeUndefined();
});

test("a listener that failed to start is tried again by the next subscribe", async () => {
  let tries = 0;
  const error = new Error("listen refused once");
  const root = createScope({
    presets: [
      listenOnly(async () => {
        tries++;

        if (tries === 1) throw error;

        return () => {};
      }),
    ],
  });

  await root.ready;
  const feed = await root.resolve(notifications);

  await expect(feed.subscribe()).rejects.toBe(error);

  const later = await feed.subscribe();

  expect(tries).toBe(2);
  expect(feed.ended(later)).toBe(false);
  feed.close(later);
  await root.close({ graceful: true });
});

test("a failed shared read is not kept for the next stream at that cursor", async () => {
  const root = createScope({ presets: [quiet] });

  await root.ready;
  const feed = await root.resolve(notifications);
  const held = await feed.subscribe();
  const error = new Error("read failed");

  await expect(
    feed.share("key", async () => ({ status: "failed" as const, error }), cursor),
  ).rejects.toBe(error);

  let reads = 0;

  expect(
    await feed.share(
      "key",
      async () => {
        reads++;
        return { status: "success" as const, value: frame };
      },
      cursor,
    ),
  ).toBe(frame);
  expect(reads).toBe(1);
  feed.close(held);
  await root.close({ graceful: true });
});
