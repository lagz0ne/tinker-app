import { createServer } from "node:net";

import { createScope } from "@tinker/core";
import { preset, makeTestClock, makeTestRandom } from "@tinker/core/testing";
import { expect, test } from "vite-plus/test";

import { databaseUrl } from "~/components/database/index.server";

import { deliverMailBatch, outboxWake, runMailWorker } from "@/backend/outbox.server";

// oxlint-disable-next-line import/no-relative-parent-imports -- Test the native command seam; app source aliases intentionally exclude cmds.
import main from "../cmds/worker";

// The endpoint accepts TCP then refuses PostgreSQL. It never receives mail or needs a database.
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

test("worker drains a full batch before waiting and stops while idle", async () => {
  const stop = new AbortController();
  const waiting = Promise.withResolvers<void>();
  let batches = 0;
  let polls = 0;
  const root = createScope({
    signal: stop.signal,
    presets: [
      preset(deliverMailBatch, async () => {
        batches += 1;
        return { claimed: batches === 1 ? 20 : 1, sent: batches === 1 ? 20 : 1, failed: 0 };
      }),
      preset(outboxWake, async (_deps, { closing }) => ({
        listen: async () => {},
        retry: async () => {
          throw new Error("Unexpected retry");
        },
        wait: async () => {
          polls += 1;
          waiting.resolve();
          await new Promise<void>((resolve) =>
            closing.addEventListener("abort", () => resolve(), { once: true }),
          );
        },
      })),
    ],
  });

  await root.ready;
  const running = root.settle(runMailWorker, { signal: stop.signal });
  try {
    await waiting.promise;
    expect(batches).toBe(2);
    expect(polls).toBe(1);
  } finally {
    stop.abort();
    await running;
    expect((await root.closed).status).toBe("success");
  }
});

test("worker command prints a clean stop and surfaces real teardown errors", async () => {
  for (const failClose of [false, true]) {
    const stop = new AbortController();
    const waiting = Promise.withResolvers<void>();
    const closeError = new Error("listener close refused");
    let output = "";

    const worker = await main({
      env: { SMTP_URL: "smtp://127.0.0.1:11026", SMTP_FROM: "board@example.test" },
      signal: stop.signal,
      stdout: {
        write: (text) => {
          output += text;
        },
      },
      stderr: {
        write: (text) => {
          output += text;
        },
      },
      presets: [
        preset(deliverMailBatch, async () => ({ claimed: 0, sent: 0, failed: 0 })),
        preset(outboxWake, async (_deps, { closing, defer }) => {
          defer(() => {
            if (failClose) throw closeError;
          });
          return {
            listen: async () => {},
            retry: async () => {},
            wait: async () => {
              waiting.resolve();
              await new Promise<void>((resolve) =>
                closing.addEventListener("abort", () => resolve(), { once: true }),
              );
            },
          };
        }),
      ],
    });

    const settled = worker.closed.then(
      () => ({ ok: true }),
      (error) => ({ error }),
    );
    await waiting.promise;
    stop.abort();
    const result = await settled;
    if (failClose) {
      expect(result).toEqual({ error: closeError });
      expect(output).not.toContain("outbox worker stopped");
    } else {
      expect(result).toEqual({ ok: true });
      expect(output).toContain("outbox worker stopped\n");
    }
  }
});
