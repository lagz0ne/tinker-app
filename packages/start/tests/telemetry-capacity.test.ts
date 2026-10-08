import { createScope } from "@tinker/core";
import { makeTestClock } from "@tinker/core/testing";
import { expect, test } from "vite-plus/test";
import { httpBackend } from "../src/backend/http-backend";
import { env } from "../src/env";
import { consoleOutput } from "../src/parts/telemetry/console";
import { exportHealth } from "../src/parts/telemetry/health";
import {
  observer,
  flushTelemetry,
  ingestTelemetry,
  telemetryExport,
} from "../src/parts/telemetry/observer";
import type { Telemetry } from "../src/parts/telemetry/records";
import { telemetrySide } from "../src/parts/telemetry/settings";

const log: Telemetry.Log = { time: 1, level: 30, service: "s", side: "server", msg: "burst" };

test("a 300-record burst is sent before the first tick, one batch at a time", async () => {
  const release = Promise.withResolvers<void>();
  const sent: Telemetry.Log[] = [];
  let requests = 0;
  let active = 0;
  let peak = 0;
  const clock = makeTestClock();
  const root = createScope({
    clock,
    extensions: [telemetryExport],
    tags: [
      env({}),
      telemetrySide("server"),
      httpBackend(async (_input, init) => {
        active++;
        peak = Math.max(peak, active);
        requests++;
        if (requests === 1) await release.promise;
        const batch = (typeof init?.body === "string" ? init.body : "")
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(batch.length).toBeLessThanOrEqual(64);
        sent.push(...batch);
        active--;
        return new Response(null);
      }),
    ],
  });
  await root.ready;
  for (let index = 0; index < 5; index++)
    root.run(ingestTelemetry, {
      input: { traces: [], logs: Array.from({ length: index === 4 ? 44 : 64 }, () => log) },
    });
  try {
    await expect.poll(() => requests).toBe(1);
    const flush = root.run(flushTelemetry);
    expect(requests).toBe(1);
    release.resolve();
    await flush;
    expect({
      records: sent.length,
      peak,
      now: clock.currentTimeMillis(),
      dropped: root.resolve(exportHealth).dropped,
    }).toEqual({ records: 300, peak: 1, now: 0, dropped: 0 });
  } finally {
    release.resolve();
    expect((await root.close({ graceful: true })).status).toBe("success");
  }
});

test("a full batch arriving as a send ends is sent before any tick", async () => {
  for (let turns = 0; turns < 14; turns++) {
    const clock = makeTestClock();
    const batch = { traces: [], logs: Array.from({ length: 64 }, () => log) };
    let incoming: Promise<void> | undefined;
    let sent = 0;
    let first = true;
    const root = createScope({
      clock,
      extensions: [telemetryExport],
      tags: [
        env({}),
        telemetrySide("ssr"),
        httpBackend(async (_input, init) => {
          if (typeof init?.body === "string") sent += init.body.split("\n").length;
          if (!first) return new Response(null);
          first = false;
          return new Response(
            new ReadableStream({
              cancel() {
                incoming = Promise.resolve().then(async () => {
                  for (let step = 0; step < turns; step++) await Promise.resolve();
                  root.run(ingestTelemetry, { input: batch });
                });
              },
            }),
          );
        }),
      ],
    });
    await root.ready;
    try {
      root.run(ingestTelemetry, { input: batch });
      await root.run(flushTelemetry);
      await incoming;
      for (let step = 0; step < 30; step++) await Promise.resolve();
      expect({
        sent,
        pending: root.resolve(exportHealth).pending,
        now: clock.currentTimeMillis(),
      }).toEqual({ sent: 128, pending: 0, now: 0 });
    } finally {
      expect((await root.close({ graceful: true })).status).toBe("success");
    }
  }
});

test("a slow console keeps a bounded batch and counts every dropped copy", async () => {
  const writes: string[] = [];
  const sink = {
    writableNeedDrain: true,
    write(text: string) {
      writes.push(text);
      this.writableNeedDrain = true;
      return false;
    },
  };
  let stored = 0;
  const root = createScope({
    extensions: [telemetryExport],
    tags: [
      env({}),
      telemetrySide("ssr"),
      consoleOutput(sink),
      httpBackend(async (_input, init) => {
        if (typeof init?.body === "string") stored += init.body.split("\n").length;
        return new Response(null);
      }),
    ],
  });
  await root.ready;
  const observe = root.resolve(observer);
  for (let index = 0; index < 600; index++)
    observe.log?.({
      level: 30,
      time: 1,
      message: "x".repeat(100),
      attributes: {},
      span: undefined,
    });
  await root.run(flushTelemetry);
  expect(writes).toEqual([]);
  sink.writableNeedDrain = false;
  await root.run(flushTelemetry);
  const text = writes.join("");
  const printed = text.trimEnd().split("\n").length;
  expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(48_000);
  const dropped = 600 - stored + 600 - printed;
  expect(root.resolve(exportHealth)).toMatchObject({ pending: 0, dropped });
  const closed = await root.close({ graceful: true, withData: true });
  expect(closed.status).toBe("success");
  expect(closed.data?.get(exportHealth)).toMatchObject({
    present: true,
    value: { pending: 0, dropped },
  });
});

test("records refused during close are counted in the final health", async () => {
  const root = createScope({
    extensions: [telemetryExport],
    tags: [
      env({}),
      telemetrySide("ssr"),
      httpBackend(async () => new Response(null, { status: 503 })),
    ],
  });
  await root.ready;
  root.run(ingestTelemetry, { input: { traces: [], logs: [log] } });
  const closed = await root.close({ graceful: true, withData: true });
  expect(closed.status).toBe("success");
  expect(closed.data?.get(exportHealth)).toMatchObject({
    present: true,
    value: { kind: "failed", pending: 0, dropped: 1 },
  });
});

test("forcing close without the telemetry extension leaves no teardown error", async () => {
  const root = createScope({
    tags: [
      env({}),
      telemetrySide("ssr"),
      httpBackend(async () => new Response(null, { status: 503 })),
    ],
  });
  root.run(ingestTelemetry, { input: { traces: [], logs: [log] } });
  const closed = await root.close();
  expect(closed).toMatchObject({ status: "cancelled", teardownErrors: undefined });
});
