import { createScope } from "@tinker/core";
import { makeTestClock, preset } from "@tinker/core/testing";
import { expect, test } from "vite-plus/test";

import { database, type Database } from "~/components/database/index.server";
import { accountNotice } from "~/components/sync/notice";
import { notifications } from "~/components/sync/notifications.server";
import type { Stream } from "~/components/sync/protocol";

const cursor: Stream.Cursor = { public: 0, private: null };
const frame: Stream.Frame = { cursor, count: 0, bytes: new Uint8Array() };

test("closing one subscriber retains shared reads; closing the last removes them", async () => {
  let reads = 0;
  const root = createScope({
    presets: [
      preset(
        database,
        async () => ({ listen: async () => () => {} }) as unknown as Database.Handle,
      ),
    ],
  });

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
      preset(
        database,
        async () =>
          ({
            listen: async (wake: typeof heard) => {
              heard = wake;
              return () => {};
            },
          }) as unknown as Database.Handle,
      ),
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
      preset(
        database,
        async () =>
          ({
            listen: async (wake: typeof heard) => {
              heard = wake;
              return () => {};
            },
          }) as unknown as Database.Handle,
      ),
    ],
  });

  await root.ready;
  const feed = await root.resolve(notifications);
  const ada = await feed.subscribe(undefined, "Ada");
  const grace = await feed.subscribe(undefined, "Grace");
  const adaWait = feed.wait(ada, 0);
  const graceWait = feed.wait(grace, 0);

  const held = feed.share("public", async () => ({ status: "success", value: frame }), cursor);
  heard(accountNotice("Ada"));
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
    presets: [
      preset(
        database,
        async () => ({ listen: async () => () => {} }) as unknown as Database.Handle,
      ),
    ],
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
    presets: [
      preset(
        database,
        async () => ({ listen: async () => () => {} }) as unknown as Database.Handle,
      ),
    ],
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
      preset(
        database,
        async () =>
          ({
            listen: async (_heard: (text: string) => void, fail: () => void) => {
              const id = broken.push(fail);
              return () => {
                closed.push(id);
              };
            },
          }) as unknown as Database.Handle,
      ),
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
