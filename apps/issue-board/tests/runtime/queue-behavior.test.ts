import { createScope } from "@tinker/core";
import { makeTestClock, preset } from "@tinker/core/testing";
import { expect, test } from "vite-plus/test";

import { abortReasons } from "~/components/errors";
import { consoleOutput } from "~/components/telemetry/console";
import { delivery } from "~/components/telemetry/delivery";
import { exportHealth } from "~/components/telemetry/health";
import { queue } from "~/components/telemetry/queue";
import type { Telemetry } from "~/components/telemetry/records";
import { telemetrySide } from "~/components/telemetry/settings";

const log: Telemetry.Log = { time: 1, level: 30, service: "proof", side: "ssr", msg: "one" };

const span: Telemetry.Span = {
  side: "browser",
  traceId: "1".repeat(32),
  spanId: "2".repeat(16),
  flags: 1,
  name: "span",
  kind: 1,
  startTimeUnixNano: "0",
  endTimeUnixNano: "1",
  attributes: [],
  events: [],
  status: { code: 1 },
};

test("empty ingest stays idle; mixed records publish and accepted kinds leave independently", async () => {
  let accept = false;
  const batches: Telemetry.Record[][] = [];
  const root = createScope({
    tags: [telemetrySide("ssr")],
    presets: [
      preset(delivery, () => ({
        send: async (batch) => {
          batches.push(batch);
          return { traces: true, logs: accept };
        },
      })),
    ],
  });

  await root.ready;
  const q = root.resolve(queue);
  try {
    q.ingest({ traces: [], logs: [] });
    expect(root.resolve(exportHealth)).toEqual({ kind: "idle", pending: 0, dropped: 0 });

    q.ingest({ traces: [span], logs: [log] });
    expect(root.resolve(exportHealth)).toEqual({ kind: "queued", pending: 2, dropped: 0 });

    await q.flush();
    expect(
      batches[0]?.map(({ kind, side, json }) => ({ kind, side, value: JSON.parse(json) })),
    ).toEqual([
      { kind: "trace", side: "browser", value: { ...span, side: undefined } },
      { kind: "log", side: "ssr", value: log },
    ]);
    const failed = {
      kind: "failed",
      failure: "Telemetry storage did not accept the batch",
      pending: 1,
      dropped: 0,
    };
    expect(root.resolve(exportHealth)).toEqual(failed);

    q.ingest({ traces: [], logs: [log] });
    expect(root.resolve(exportHealth)).toEqual({ ...failed, pending: 2 });
    accept = true;

    await q.flush();
    expect(batches[1]?.map(({ kind }) => kind)).toEqual(["log", "log"]);
    expect(root.resolve(exportHealth)).toEqual({ kind: "idle", pending: 0, dropped: 0 });
    await q.close(true);
    expect(q.add("log", "ssr", log)).toBeUndefined();
    q.writeConsole(undefined, log);

    await q.flush();
    expect(batches).toHaveLength(2);
  } finally {
    await root.close({ graceful: true });
  }
});

test("console encodes uncached logs, keeps exactly 512 lines, and frees its byte budget", async () => {
  const writes: string[] = [];
  const sink = { writableNeedDrain: true, write: (line: string) => writes.push(line) };
  const root = createScope({
    tags: [telemetrySide("ssr"), consoleOutput(sink)],
    presets: [preset(delivery, () => ({ send: async () => ({ traces: true, logs: true }) }))],
  });

  await root.ready;
  const q = root.resolve(queue);
  try {
    for (let index = 0; index < 513; index++) q.writeConsole(undefined, log);
    q.publishQueued();
    expect(root.resolve(exportHealth).dropped).toBe(1);

    await q.flush();
    expect(writes).toEqual([]);
    sink.writableNeedDrain = false;

    await q.flush();
    expect(writes).toEqual([`${Array(512).fill(JSON.stringify(log)).join("\n")}\n`]);
    q.writeConsole(undefined, log);

    await q.flush();
    expect(writes[1]).toBe(`${JSON.stringify(log)}\n`);
    const large = { ...log, msg: "😀".repeat(20_000) };
    q.writeConsole(undefined, large);
    q.publishQueued();
    expect(root.resolve(exportHealth).dropped).toBe(2);

    await q.flush();
    expect(writes).toHaveLength(2);
  } finally {
    await root.close({ graceful: true });
  }
});

test("console accepts its exact byte limit and rejects even a newline beyond it", async () => {
  const writes: string[] = [];
  const root = createScope({
    tags: [telemetrySide("ssr"), consoleOutput({ write: (line) => writes.push(line) })],
    presets: [preset(delivery, () => ({ send: async () => ({ traces: true, logs: true }) }))],
  });

  await root.ready;
  const q = root.resolve(queue);
  try {
    const empty = { ...log, msg: "" };
    const exact = { ...empty, msg: "x".repeat(47_999 - JSON.stringify(empty).length) };
    q.writeConsole(undefined, exact);
    q.writeConsole(undefined, log);
    q.publishQueued();
    expect(root.resolve(exportHealth).dropped).toBe(1);

    await q.flush();
    expect(writes).toEqual([`${JSON.stringify(exact)}\n`]);
    q.writeConsole(undefined, { ...exact, msg: exact.msg + "x" });
    q.publishQueued();
    expect(root.resolve(exportHealth).dropped).toBe(2);
  } finally {
    await root.close({ graceful: true });
  }
});

test("browser frames count commas and trace side bytes at the exact UTF-8 boundary", async () => {
  const batches: Telemetry.Record[][] = [];
  const root = createScope({
    tags: [telemetrySide("browser")],
    presets: [
      preset(delivery, () => ({
        send: async (batch) => {
          batches.push(batch);
          return { traces: true, logs: true };
        },
      })),
    ],
  });

  await root.ready;
  const q = root.resolve(queue);
  try {
    const empty = { ...log, msg: "" };
    const value = { ...empty, msg: "x".repeat(15_988 - JSON.stringify(empty).length) };

    q.ingest({ traces: [], logs: [value, value] });

    await q.flush();
    expect(batches.map((batch) => batch.length)).toEqual([1]);

    await q.flush();
    expect(batches.map((batch) => batch.length)).toEqual([1, 1]);
    const { side, ...body } = span;
    const exact = { ...body, name: "" };
    exact.name = "x".repeat(31_976 - side.length - 10 - JSON.stringify(exact).length);
    expect(q.add("trace", side, exact)?.bytes).toBe(31_976);
    q.publishQueued();
    expect(root.resolve(exportHealth)).toMatchObject({ pending: 1, dropped: 0 });
    q.add("trace", side, { ...exact, name: exact.name + "x" });
    q.publishQueued();
    expect(root.resolve(exportHealth)).toMatchObject({ pending: 1, dropped: 1 });
  } finally {
    await root.close({ graceful: true });
  }
});

test("closing publishes final drops once and cannot restart sends or retain console lines", async () => {
  const clock = makeTestClock();
  const signals: AbortSignal[] = [];
  const root = createScope({
    clock,
    tags: [
      telemetrySide("ssr"),
      consoleOutput({
        writableNeedDrain: true,
        write: () => expect.unreachable("blocked console"),
      }),
    ],
    presets: [
      preset(delivery, () => ({
        send: async (_batch, signal) => {
          signals.push(signal);
          return { traces: false, logs: false };
        },
      })),
    ],
  });

  await root.ready;
  const q = root.resolve(queue);

  q.ingest({ traces: [], logs: [log] });
  q.writeConsole(undefined, log);
  await q.close(true);
  expect(signals).toHaveLength(1);
  expect(root.resolve(exportHealth)).toEqual({
    kind: "failed",
    failure: "Telemetry storage did not accept the batch",
    pending: 0,
    dropped: 2,
  });

  q.ingest({ traces: [], logs: [log] });
  q.writeConsole(undefined, log);
  await q.close(true);
  await q.flush();
  expect(signals).toHaveLength(1);
  expect(root.resolve(exportHealth)).toMatchObject({ pending: 0, dropped: 2 });
  expect((await root.close({ graceful: true })).teardownErrors).toBeUndefined();
});

test("the periodic timer flushes at one second and stops when the queue closes", async () => {
  const clock = makeTestClock();
  const sleeps: { ms: number; signal: AbortSignal | undefined }[] = [];
  const batches: Telemetry.Record[][] = [];
  const root = createScope({
    clock: {
      ...clock,
      sleep: (ms, signal) => {
        sleeps.push({ ms, signal });
        return clock.sleep(ms, signal);
      },
    },
    tags: [telemetrySide("server")],
    presets: [
      preset(delivery, () => ({
        send: async (batch) => {
          batches.push(batch);
          return { traces: true, logs: true };
        },
      })),
    ],
  });

  await root.ready;
  const q = root.resolve(queue);
  q.start(() => q.flush());
  q.ingest({ traces: [], logs: [log] });
  await expect.poll(() => sleeps.filter(({ ms }) => ms === 1000).length).toBe(1);
  clock.advance(999);
  expect(batches).toEqual([]);
  clock.advance(1);
  await expect.poll(() => batches.length).toBe(1);
  await expect.poll(() => sleeps.filter(({ ms }) => ms === 1000).length).toBe(2);
  expect(batches[0]?.map(({ json }) => JSON.parse(json))).toEqual([log]);
  await q.close(true);
  expect(sleeps.filter(({ ms }) => ms === 1000).every(({ signal }) => signal?.aborted)).toBe(true);
  clock.advance(10_000);
  expect(batches).toHaveLength(1);
  await root.close({ graceful: true });
});

test("a failed periodic clock reaches close as its original error and still clears retained work", async () => {
  const clock = makeTestClock();
  const tick = Promise.withResolvers<void>();
  const waiting = Promise.withResolvers<void>();
  const error = new Error("clock failed");
  const root = createScope({
    clock: {
      ...clock,
      sleep: (ms, signal) => {
        if (ms === 1000) {
          waiting.resolve();
          return tick.promise;
        }
        return clock.sleep(ms, signal);
      },
    },
    tags: [telemetrySide("server")],
    presets: [
      preset(delivery, () => ({
        send: async () => expect.unreachable("timer failed before flush"),
      })),
    ],
  });

  await root.ready;
  const q = root.resolve(queue);
  q.start(() => q.flush());
  q.ingest({ traces: [], logs: [log] });
  await waiting.promise;
  // Let the clock failure reach the timer before close joins it.
  tick.reject(error);
  await Promise.resolve();
  await Promise.resolve();
  const closed = expect(q.close(true)).rejects.toBe(error);
  await closed;
  expect(root.resolve(exportHealth)).toEqual({ kind: "idle", pending: 0, dropped: 1 });
  await q.flush();
  expect((await root.close({ graceful: true })).teardownErrors).toBeUndefined();
});

test("a storage request gets 750 ms, then aborts with the timeout reason and retains its records", async () => {
  const clock = makeTestClock();
  const started = Promise.withResolvers<AbortSignal>();
  const sent: AbortSignal[] = [];
  const root = createScope({
    clock,
    tags: [telemetrySide("ssr")],
    presets: [
      preset(delivery, () => ({
        send: async (_batch, signal) => {
          sent.push(signal);
          started.resolve(signal);
          if (!signal.aborted) {
            await new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true }),
            );
          }
          return { traces: false, logs: false };
        },
      })),
    ],
  });

  await root.ready;
  const q = root.resolve(queue);
  q.ingest({ traces: [], logs: [log] });
  const flushed = q.flush();
  const signal = await started.promise;
  clock.advance(749);
  expect(signal.aborted).toBe(false);
  clock.advance(1);
  await Promise.resolve();
  expect(signal.aborted).toBe(true);
  expect(signal.reason).toBe(abortReasons.timeout);
  await flushed;
  expect(root.resolve(exportHealth)).toMatchObject({ kind: "failed", pending: 1, dropped: 0 });
  // The next failed close attempt is held too; its own request deadline frees it.
  const closed = q.close(true);
  await expect.poll(() => sent.length).toBe(2);
  clock.advance(1500);
  await closed;
  expect(root.resolve(exportHealth)).toMatchObject({ pending: 0, dropped: 1 });
  await root.close({ graceful: true });
});

test("SSR never starts a periodic timer and close cancels its delivery alarms", async () => {
  const clock = makeTestClock();
  const alarms: AbortSignal[] = [];
  const root = createScope({
    clock: {
      ...clock,
      sleep: (ms, signal) => {
        expect(ms).not.toBe(1000);
        if (signal) alarms.push(signal);
        return clock.sleep(ms, signal);
      },
    },
    tags: [telemetrySide("ssr")],
    presets: [preset(delivery, () => ({ send: async () => ({ traces: true, logs: true }) }))],
  });

  await root.ready;
  const q = root.resolve(queue);
  q.start(() => q.flush());
  await Promise.resolve();
  q.ingest({ traces: [], logs: [log] });
  await q.close(true);
  expect(alarms).toHaveLength(2);
  expect(alarms.every((signal) => signal.aborted)).toBe(true);
  expect(root.resolve(exportHealth)).toEqual({ kind: "idle", pending: 0, dropped: 0 });
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("console reuses a cached log and never encodes an input when its byte budget is full", async () => {
  const writes: string[] = [];
  const root = createScope({
    tags: [telemetrySide("ssr"), consoleOutput({ write: (text) => writes.push(text) })],
    presets: [preset(delivery, () => ({ send: async () => ({ traces: true, logs: true }) }))],
  });

  await root.ready;
  const q = root.resolve(queue);
  const value = { ...log };
  const cached = q.add("log", "ssr", value);
  Object.defineProperty(value, "msg", { get: () => expect.unreachable("already cached") });
  q.writeConsole(cached, value);
  await q.flush();
  expect(writes).toEqual([`${JSON.stringify(log)}\n`]);
  const empty = { ...log, msg: "" };
  const full = { ...empty, msg: "x".repeat(47_999 - JSON.stringify(empty).length) };
  q.writeConsole(undefined, full);
  q.writeConsole(undefined, value);
  q.publishQueued();
  expect(root.resolve(exportHealth).dropped).toBe(1);
  await q.flush();
  expect(writes[1]).toBe(`${JSON.stringify(full)}\n`);
  await root.close({ graceful: true });
});

test("close flushes console-only work and aborts every delivery signal", async () => {
  const writes: string[] = [];
  const signals: AbortSignal[] = [];
  const root = createScope({
    tags: [telemetrySide("ssr"), consoleOutput({ write: (line) => writes.push(line) })],
    presets: [
      preset(delivery, () => ({
        send: async (_batch, signal) => {
          signals.push(signal);
          return { traces: true, logs: true };
        },
      })),
    ],
  });

  await root.ready;
  const q = root.resolve(queue);
  q.ingest({ traces: [], logs: [log] });
  await q.flush();
  expect(signals[0]?.aborted).toBe(false);
  q.writeConsole(undefined, log);
  await q.close(true);
  expect(writes).toEqual([`${JSON.stringify(log)}\n`]);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(root.resolve(exportHealth)).toEqual({ kind: "idle", pending: 0, dropped: 0 });
  await root.close({ graceful: true });
});

test("under steady load the console mirror keeps writing while one flush drains batch after batch", async () => {
  const writes: string[] = [];
  const load = { rounds: 0, arrive: () => {} };
  const root = createScope({
    tags: [telemetrySide("ssr"), consoleOutput({ write: (text) => writes.push(text) })],
    presets: [
      preset(delivery, () => ({
        send: async () => {
          if (++load.rounds < 10) load.arrive();
          return { traces: true, logs: true };
        },
      })),
    ],
  });
  await root.ready;
  const q = root.resolve(queue);
  load.arrive = () => {
    for (let index = 0; index < 64; index++) {
      q.writeConsole(q.add("log", "ssr", log), log);
      q.publishQueued();
    }
  };

  load.arrive();
  await q.flush();

  expect(load.rounds).toBe(10);
  expect(writes.join("").split("\n").filter(Boolean)).toHaveLength(640);
  await root.close({ graceful: true });
});
