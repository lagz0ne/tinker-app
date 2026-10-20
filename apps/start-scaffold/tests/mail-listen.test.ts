import { createServer } from "node:net";

import { createScope } from "@tinker/core";
import { preset, makeTestClock, makeTestRandom } from "@tinker/core/testing";
import { expect, test } from "vite-plus/test";

import { databaseUrl, databaseConnectTimeout } from "~/components/database/index.server";
import { deliverMailBatch, runMailWorker, outboxWake } from "~/components/mail/index.server";

test("worker connect attempts stay bounded across late end events and clock ticks", async () => {
  let accepts = 0;
  const server = createServer((socket) => {
    accepts += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected local TCP endpoint");

  const clock = makeTestClock();
  const stop = new AbortController();
  const delays: number[] = [];
  let attempted = Promise.withResolvers<void>();
  const root = createScope({
    signal: stop.signal,
    clock,
    random: makeTestRandom({ seed: 42 }),
    tags: [databaseUrl(new URL(`postgres://proof@127.0.0.1:${address.port}/proof`))],
    presets: [
      preset(deliverMailBatch, async () => {
        throw new Error("No claim before a connection");
      }),
    ],
    observe: {
      history: 10,
      log: (entry) => {
        if (entry.message === "outbox.reconnect") {
          delays.push(Number(entry.attributes.delay));
          attempted.resolve();
        }
      },
    },
  });

  await root.ready;
  const running = root.settle(runMailWorker, { signal: stop.signal });
  try {
    await attempted.promise;
    for (let index = 0; index < 9; index += 1) {
      // Let pg's deferred error/end events and the full promise chain run.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(accepts).toBe(index + 1);
      const cap = Math.min(30_000, 1000 * 2 ** Math.min(index, 5));
      expect(delays[index]).toBeGreaterThanOrEqual(cap / 2);
      expect(delays[index]).toBeLessThanOrEqual(cap);

      attempted = Promise.withResolvers<void>();
      clock.advance(delays[index]! - 1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(accepts).toBe(index + 1);
      clock.advance(1);
      await attempted.promise;
    }
    expect(accepts).toBe(10);
    expect(new Set(delays).size).toBeGreaterThan(1);
  } finally {
    stop.abort();
    await running;
    expect((await root.closed).status).toBe("success");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("stop interrupts a black-holed LISTEN handshake", async () => {
  const sockets = new Set<import("node:net").Socket>();

  const accepted = Promise.withResolvers<void>();

  const server = createServer((socket) => {
    sockets.add(socket);

    accepted.resolve();

    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));

  const address = server.address();

  if (!address || typeof address === "string") throw new Error("Expected TCP endpoint");

  const { mailWorkerStop } = await import("~/components/mail/index.server");

  const stopping = new AbortController();

  const root = createScope({
    tags: [
      databaseUrl(new URL(`postgres://proof@127.0.0.1:${address.port}/proof`)),
      mailWorkerStop(stopping.signal),
      databaseConnectTimeout(100),
    ],
  });

  try {
    const wake = await root.resolve(outboxWake);

    const listening = wake.listen();

    const result = listening.catch((error) => error);

    await accepted.promise;

    stopping.abort();

    expect(await result).toBe(stopping.signal.reason);

    await Promise.race([
      root.close({ graceful: true }),
      new Promise((_, reject) =>
        AbortSignal.timeout(1000).addEventListener(
          "abort",
          () => reject(new Error("stop must settle before host grace")),
          { once: true },
        ),
      ),
    ]);
  } finally {
    for (const socket of sockets) socket.destroy();

    await root.close();

    await new Promise<void>((done) => server.close(() => done()));
  }
});
