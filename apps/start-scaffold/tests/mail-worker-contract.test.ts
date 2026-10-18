import { createScope, type Observe } from "@tinker/core";
import { makeTestClock, makeTestRandom, preset } from "@tinker/core/testing";
import { expect, test } from "vite-plus/test";

import { database, type Database } from "~/components/database/index.server";
import {
  deliverMailBatch,
  mailWorkerStop,
  outboxWake,
  runMailWorker,
} from "~/components/mail/index.server";

test("outbox wake remembers a send-time wake, closes a dropped listener, and polls after silence", async () => {
  const clock = makeTestClock();
  const stop = new AbortController();
  const sleeps: { ms: number; signal: AbortSignal | undefined }[] = [];
  const closes: number[] = [];
  const opened: { heard: () => void; dropped: () => void; signal: AbortSignal | undefined }[] = [];
  const root = createScope({
    clock: {
      ...clock,
      sleep: (ms, signal) => {
        sleeps.push({ ms, signal });
        return clock.sleep(ms, signal);
      },
    },
    tags: [mailWorkerStop(stop.signal)],
    presets: [
      preset(
        database,
        async () =>
          ({
            listen: async (
              channel: string,
              heard: () => void,
              dropped: () => void,
              signal?: AbortSignal,
            ) => {
              expect(channel).toBe("board_outbox");
              const id = opened.push({ heard, dropped, signal });
              return () => {
                closes.push(id);
              };
            },
          }) as unknown as Database.Handle,
      ),
    ],
  });

  try {
    const wake = await root.resolve(outboxWake);
    await wake.listen();
    await wake.listen();

    expect(opened).toHaveLength(1);
    opened[0]!.heard();
    await wake.wait();
    expect(sleeps).toEqual([]);
    let finished = false;
    const waiting = wake.wait().then(() => {
      finished = true;
    });
    expect(sleeps.map((entry) => entry.ms)).toEqual([30000]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    opened[0]!.heard();
    await waiting;
    expect(sleeps[0]!.signal!.aborted).toBe(true);
    opened[0]!.dropped();
    await wake.wait();
    expect(sleeps).toHaveLength(1);
    await wake.listen();
    expect(opened).toHaveLength(2);
    expect(closes).toEqual([1]);
    finished = false;
    const poll = wake.wait().then(() => {
      finished = true;
    });
    clock.advance(29999);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    clock.advance(1);
    await poll;
    const interrupted = wake.wait();
    stop.abort();
    await interrupted;
    expect(opened[1]!.signal!.aborted).toBe(true);
    expect((await root.close({ graceful: true })).status).toBe("success");
    expect(closes).toEqual([1, 2]);
  } finally {
    stop.abort();
    await root.close();
  }
});

test("outbox reconnect delay grows with exact jitter, caps, then resets after a healthy wait", async () => {
  const clock = makeTestClock();
  const delays: number[] = [];
  const logs: Observe.Log[] = [];
  const random = makeTestRandom({ seed: 10 });
  const expected = makeTestRandom({ seed: 10 });
  const root = createScope({
    clock: {
      ...clock,
      sleep: async (ms, signal) => {
        signal?.throwIfAborted();
        delays.push(ms);
      },
    },
    random,
    observe: { history: 30, log: (entry) => logs.push(entry) },
    presets: [
      preset(
        database,
        async () => ({ listen: async () => () => {} }) as unknown as Database.Handle,
      ),
    ],
  });

  try {
    const wake = await root.resolve(outboxWake);
    for (let index = 0; index < 8; index++) {
      await wake.retry();
      expect(delays[index]).toBe(
        Math.floor(Math.min(30000, 1000 * 2 ** Math.min(index, 5)) * (0.5 + expected.next() / 2)),
      );
    }

    expect(
      logs.filter((entry) => entry.message === "outbox.reconnect").map((entry) => entry.attributes),
    ).toEqual(delays.map((delay, index) => ({ attempt: index + 1, delay })));
    await wake.listen();
    await wake.wait();
    expect(delays.at(-1)).toBe(30000);
    await wake.retry();
    expect(delays.at(-1)).toBe(Math.floor(1000 * (0.5 + expected.next() / 2)));
  } finally {
    await root.close();
  }
});

for (const method of ["retry", "wait"] as const) {
  test(`outbox ${method} reports a clock error but suppresses stop cancellation`, async () => {
    const stop = new AbortController();
    const clockError = new Error("clock failed");
    let stopping = false;
    const root = createScope({
      tags: [mailWorkerStop(stop.signal)],
      clock: {
        ...makeTestClock(),
        sleep: async () => {
          if (stopping) stop.abort();
          throw clockError;
        },
      },
      presets: [
        preset(
          database,
          async () => ({ listen: async () => () => {} }) as unknown as Database.Handle,
        ),
      ],
    });
    try {
      const wake = await root.resolve(outboxWake);
      await wake.listen();
      await expect(wake[method]()).rejects.toBe(clockError);
      stopping = true;
      await expect(wake[method]()).resolves.toBeUndefined();
    } finally {
      stop.abort();
      await root.close();
    }
  });
}

test("outbox listener is refused before opening after its soft stop", async () => {
  const stop = new AbortController();
  const reason = new Error("worker stopped");
  let listens = 0;
  const root = createScope({
    tags: [mailWorkerStop(stop.signal)],
    presets: [
      preset(
        database,
        async () =>
          ({
            listen: async () => {
              listens++;
              return () => {};
            },
          }) as unknown as Database.Handle,
      ),
    ],
  });
  try {
    const wake = await root.resolve(outboxWake);
    stop.abort(reason);
    await expect(wake.listen()).rejects.toBe(reason);
    expect(listens).toBe(0);
  } finally {
    await root.close();
  }
});

for (const fail of ["listen", "deliver", "none"] as const) {
  test(`worker ${fail} path drains full batches, logs failures, and waits only after draining`, async () => {
    const stop = new AbortController();
    const order: string[] = [];
    const logs: Observe.Log[] = [];
    let claims = 0;
    let refused = false;
    const root = createScope({
      tags: [mailWorkerStop(stop.signal)],
      observe: { history: 20, log: (entry) => logs.push(entry) },
      presets: [
        preset(outboxWake, async () => ({
          listen: async () => {
            order.push("listen");
            if (fail === "listen" && !refused) {
              refused = true;
              throw new Error("listener down");
            }
          },
          retry: async () => {
            order.push("retry");
          },
          wait: async () => {
            order.push("wait");
            stop.abort();
          },
        })),
        preset(deliverMailBatch, async () => {
          order.push("deliver");
          if (fail === "deliver" && !refused) {
            refused = true;
            throw new Error("database down");
          }
          return { claimed: ++claims === 1 ? 20 : 1, sent: 0, failed: 0 };
        }),
      ],
    });

    try {
      const result = await root.settle(runMailWorker, { signal: new AbortController().signal });
      expect(result.status).toBe("success");
      expect(order).toEqual([
        ...(fail === "listen"
          ? ["listen", "retry"]
          : fail === "deliver"
            ? ["listen", "deliver", "retry"]
            : []),
        "listen",
        "deliver",
        "deliver",
        "wait",
      ]);
      expect(logs.filter((entry) => entry.message === "outbox.unavailable")).toMatchObject(
        fail === "none"
          ? []
          : [
              {
                attributes: { error: `Error: ${fail === "listen" ? "listener" : "database"} down` },
              },
            ],
      );
    } finally {
      stop.abort();
      await root.close();
    }
  });
}

test("worker stops during a full batch without draining or waiting again", async () => {
  const stop = new AbortController();
  const order: string[] = [];
  const root = createScope({
    tags: [mailWorkerStop(stop.signal)],
    presets: [
      preset(outboxWake, async () => ({
        listen: async () => {
          order.push("listen");
        },
        retry: async () => {
          order.push("retry");
        },
        wait: async () => {
          order.push("wait");
        },
      })),
      preset(deliverMailBatch, async () => {
        order.push("deliver");
        stop.abort();
        return { claimed: 20, sent: 1, failed: 0 };
      }),
    ],
  });
  try {
    expect((await root.settle(runMailWorker)).status).toBe("success");
    expect(order).toEqual(["listen", "deliver"]);
  } finally {
    stop.abort();
    await root.close();
  }
});
