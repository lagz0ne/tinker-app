import { createServer } from "node:http";
import { test, expect } from "vite-plus/test";
import { createScope, operation } from "@tinker/core";
import { makeTestClock } from "@tinker/core/testing";
import {
  telemetry,
  telemetrySettings,
  telemetryBackend,
  observer,
  flushTelemetry,
  ingestTelemetry,
  exportHealth,
} from "@tinker-start-scaffold/telemetry";
import {
  receiveTelemetry,
  browserTelemetry,
  telemetryOrigin,
  backendStop,
  requestStop,
} from "@tinker-start-scaffold/transport";
import { raise } from "@tinker-start-scaffold/backend";
import type { Telemetry } from "@tinker-start-scaffold/telemetry";

class Receiver {
  requests: { path: string; body: string }[] = [];
  private mode: "accept" | "reject" | "stuck" = "accept";
  private started = Promise.withResolvers<void>();
  arrived = this.started.promise;
  url = "";
  private server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    this.requests.push({ path: request.url ?? "", body: Buffer.concat(chunks).toString() });
    this.started.resolve();
    if (this.mode !== "stuck") {
      response.writeHead(this.mode === "accept" ? 200 : 503);
      response.end();
    }
  });
  async start() {
    await new Promise<void>((done) => this.server.listen(0, "127.0.0.1", done));
    const address = this.server.address();
    if (!address || typeof address === "string") raise("BadInput", { reason: "receiver address" });
    this.url = `http://127.0.0.1:${address.port}`;
    return this;
  }
  setMode(mode: typeof this.mode) {
    this.mode = mode;
  }
  async close() {
    this.server.closeAllConnections();
    await new Promise<void>((done, failed) =>
      this.server.close((error) => (error ? failed(error) : done())),
    );
  }
}
const child = operation({
  label: "test.telemetry.child",
  run: (_deps, ctx) => {
    const cycle: Record<string, unknown> = {};
    cycle.loop = cycle;
    ctx.obs.event("saved", { count: 1, big: 42n, cycle });
    ctx.log("saved record", { count: 1, big: 42n, cycle });
    return "saved";
  },
});
const parent = operation({
  label: "test.telemetry.parent",
  depends: { child },
  run: ({ child }) => child.run(),
});
const rejected = operation({ label: "test.telemetry.rejected", run: () => raise("Rollback", {}) });

test("finished operation traces and Pino logs reach their HTTP receivers", async () => {
  const receiver = await new Receiver().start();
  const clock = makeTestClock({ now: 1_800_000_000_000 });
  const toolStop = new AbortController();
  const tools = createScope({
    signal: toolStop.signal,
    extensions: [telemetry],
    tags: telemetrySettings({
      side: "ssr",
      service: "test-start",
      level: "info",
      traces: `${receiver.url}/traces`,
      logs: `${receiver.url}/logs`,
    }),
    clock,
  });
  await tools.ready;
  const stop = new AbortController();
  const app = createScope({ signal: stop.signal, observe: await tools.resolve(observer), clock });
  await app.ready;
  try {
    expect(app.run(parent)).toBe("saved");
    const result = app.settle(rejected);
    if (result.status === "success") raise("BadInput", { reason: "rejected operation succeeded" });
    await tools.run(flushTelemetry);
    expect(
      JSON.parse(receiver.requests.find((request) => request.path === "/traces")?.body ?? "null"),
    ).toMatchObject({
      resourceSpans: [
        {
          resource: {
            attributes: expect.arrayContaining([
              { key: "tinker.side", value: { stringValue: "ssr" } },
            ]),
          },
          scopeSpans: [
            {
              spans: expect.arrayContaining([
                expect.objectContaining({
                  name: "test.telemetry.child",
                  parentSpanId: expect.stringMatching(/^[0-9a-f]{16}$/),
                  traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
                  startTimeUnixNano: "1800000000000000000",
                  endTimeUnixNano: "1800000000000000000",
                  status: { code: 1 },
                  events: expect.arrayContaining([
                    expect.objectContaining({
                      name: "saved",
                      timeUnixNano: "1800000000000000000",
                      attributes: expect.arrayContaining([
                        { key: "count", value: { stringValue: "1" } },
                        { key: "big", value: { stringValue: "42" } },
                        { key: "cycle", value: { stringValue: "[Unserializable]" } },
                      ]),
                    }),
                  ]),
                }),
                expect.objectContaining({
                  name: "test.telemetry.rejected",
                  status: { code: 2, message: expect.any(String) },
                }),
              ]),
            },
          ],
        },
      ],
    });
    const logs = receiver.requests.find((request) => request.path.startsWith("/logs?"));
    if (!logs) raise("BadInput", { reason: "No received logs" });
    expect(logs.path).toContain("_stream_fields=service%2Cside");
    expect(logs.body.split("\n").map((line) => JSON.parse(line))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          time: 1_800_000_000_000,
          level: 30,
          service: "test-start",
          side: "ssr",
          msg: "saved record",
          traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
          spanId: expect.stringMatching(/^[0-9a-f]{16}$/),
          attributes: { count: "1", big: "42", cycle: "[Unserializable]" },
        }),
      ]),
    );
  } finally {
    stop.abort();
    await app.closed;
    toolStop.abort();
    expect(await tools.closed).toMatchObject({ status: "success", teardownErrors: undefined });
    await receiver.close();
  }
});

test("storage failure keeps the business result and retries retained records", async () => {
  const receiver = await new Receiver().start();
  receiver.setMode("reject");
  const toolStop = new AbortController();
  const tools = createScope({
    signal: toolStop.signal,
    extensions: [telemetry],
    tags: telemetrySettings({
      side: "ssr",
      service: "test-start",
      level: "info",
      traces: `${receiver.url}/traces`,
      logs: `${receiver.url}/logs`,
    }),
  });
  await tools.ready;
  const stop = new AbortController();
  const app = createScope({ signal: stop.signal, observe: await tools.resolve(observer) });
  await app.ready;
  try {
    expect(app.run(child)).toBe("saved");
    await tools.run(flushTelemetry);
    expect(tools.resolve(exportHealth)).toMatchObject({ kind: "failed", pending: 3, dropped: 0 });
    receiver.setMode("accept");
    await tools.run(flushTelemetry);
    expect(tools.resolve(exportHealth)).toEqual({ kind: "idle", pending: 0, dropped: 0 });
  } finally {
    stop.abort();
    await app.closed;
    toolStop.abort();
    expect(await tools.closed).toMatchObject({ status: "success", teardownErrors: undefined });
    await receiver.close();
  }
});

test("owner close flushes finished records without a scheduled browser timer", async () => {
  const receiver = await new Receiver().start();
  const toolStop = new AbortController();
  const tools = createScope({
    signal: toolStop.signal,
    extensions: [telemetry],
    tags: telemetrySettings({
      side: "ssr",
      service: "test-start",
      level: "info",
      traces: `${receiver.url}/traces`,
      logs: `${receiver.url}/logs`,
    }),
  });
  await tools.ready;
  const stop = new AbortController();
  const app = createScope({ signal: stop.signal, observe: await tools.resolve(observer) });
  await app.ready;
  app.run(child);
  stop.abort();
  await app.closed;
  toolStop.abort();
  expect(await tools.closed).toMatchObject({ status: "success", teardownErrors: undefined });
  expect(receiver.requests.map((request) => new URL(request.path, receiver.url).pathname)).toEqual([
    "/traces",
    "/logs",
  ]);
  await receiver.close();
});

test("a stuck receiver is aborted by the owned Core clock during close", async () => {
  const receiver = await new Receiver().start();
  receiver.setMode("stuck");
  const clock = makeTestClock();
  const toolStop = new AbortController();
  const tools = createScope({
    signal: toolStop.signal,
    clock,
    extensions: [telemetry],
    tags: telemetrySettings({
      side: "ssr",
      service: "test-start",
      level: "info",
      traces: `${receiver.url}/traces`,
      logs: `${receiver.url}/logs`,
    }),
  });
  await tools.ready;
  const stop = new AbortController();
  const app = createScope({ signal: stop.signal, clock, observe: await tools.resolve(observer) });
  await app.ready;
  app.run(child);
  stop.abort();
  await app.closed;
  toolStop.abort();
  await receiver.arrived;
  clock.advance(1500);
  expect(await tools.closed).toMatchObject({ status: "success", teardownErrors: undefined });
  await receiver.close();
});

test("browser ingest accepts only same-origin bounded browser records", async () => {
  const accepted: Telemetry.Batch[] = [];
  const stop = new AbortController();
  const app = createScope({
    signal: stop.signal,
    tags: [
      telemetryOrigin("https://localhost"),
      backendStop(stop.signal),
      requestStop(stop.signal),
      browserTelemetry(async (batch) => {
        accepted.push(batch);
      }),
    ],
  });
  await app.ready;
  const valid: Telemetry.Batch = {
    traces: [],
    logs: [{ time: 1, level: 30, msg: "browser record", side: "browser", service: "test-start" }],
  };
  const send = (body: string, origin = "https://localhost") =>
    app.run(receiveTelemetry, {
      input: new Request("http://localhost/api/telemetry", {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body,
      }),
    });
  try {
    expect((await send(JSON.stringify(valid))).status).toBe(202);
    expect((await send(JSON.stringify(valid), "http://other.test")).status).toBe(403);
    expect((await send(" ".repeat(65_537))).status).toBe(413);
    expect(
      (await send(JSON.stringify({ ...valid, destination: "http://other.test" }))).status,
    ).toBe(400);
    expect(
      (
        await send(
          JSON.stringify({
            traces: [],
            logs: [{ time: 1, level: 30, msg: "server", side: "server", service: "test" }],
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await send(
          JSON.stringify({
            traces: [],
            logs: Array.from({ length: 65 }, () => ({
              time: 1,
              level: 30,
              msg: "browser record",
              side: "browser",
              service: "test-start",
            })),
          }),
        )
      ).status,
    ).toBe(400);
    expect(accepted).toEqual([valid]);
  } finally {
    stop.abort();
    await app.closed;
  }
});

test("a full telemetry queue reports dropped records within its bound", async () => {
  const receiver = await new Receiver().start();
  const stop = new AbortController();
  const tools = createScope({
    signal: stop.signal,
    extensions: [telemetry],
    tags: telemetrySettings({
      side: "ssr",
      service: "test-start",
      level: "info",
      traces: `${receiver.url}/traces`,
      logs: `${receiver.url}/logs`,
    }),
  });
  await tools.ready;
  const batch: Telemetry.Batch = {
    traces: [],
    logs: Array.from({ length: 64 }, () => ({
      time: 1,
      level: 30,
      msg: "queued",
      service: "test-start",
      side: "ssr",
    })),
  };
  for (let index = 0; index < 9; index++) tools.run(ingestTelemetry, { input: batch });
  expect(tools.resolve(exportHealth)).toEqual({ kind: "queued", pending: 512, dropped: 64 });
  stop.abort();
  expect(await tools.closed).toMatchObject({ status: "success", teardownErrors: undefined });
  expect(
    receiver.requests.every(
      (request) => new TextEncoder().encode(request.body).byteLength <= 65_536,
    ),
  ).toBe(true);
  await receiver.close();
});

test("scope exit cancels an unfinished telemetry request body", async () => {
  const entered = Promise.withResolvers<void>();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        entered.resolve();
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const request = new Request(
    "http://localhost/api/telemetry",
    Object.assign(
      {
        method: "POST",
        headers: { origin: "http://localhost", "content-type": "application/json" },
        body,
      },
      { duplex: "half" },
    ),
  );
  const stop = new AbortController();
  const app = createScope({
    signal: stop.signal,
    tags: [
      telemetryOrigin("http://localhost"),
      backendStop(stop.signal),
      requestStop(stop.signal),
      browserTelemetry(async () => {
        raise("BadInput", { reason: "Incomplete body cannot ingest" });
      }),
    ],
  });
  await app.ready;
  const work = app.settle(receiveTelemetry, { input: request });
  await entered.promise;
  stop.abort();
  const result = await work;
  if (result.status !== "success")
    raise("BadInput", { reason: "Body close did not return a response" });
  expect(result.value.status).toBe(503);
  expect(await app.closed).toMatchObject({ status: "success", teardownErrors: undefined });
  expect(cancelled).toBe(true);
});

test("accepted telemetry frees the byte budget for later records", async () => {
  const receiver = await new Receiver().start();
  const stop = new AbortController();
  const tools = createScope({
    signal: stop.signal,
    extensions: [telemetry],
    tags: telemetrySettings({
      side: "ssr",
      service: "test-start",
      level: "info",
      traces: `${receiver.url}/traces`,
      logs: `${receiver.url}/logs`,
    }),
  });
  await tools.ready;
  try {
    for (let round = 0; round < 40; round += 1) {
      tools.run(ingestTelemetry, {
        input: {
          traces: [],
          logs: Array.from({ length: 8 }, () => ({
            time: 0,
            level: 30,
            msg: "x".repeat(2048),
            service: "test-start",
            side: "ssr" as const,
            attributes: { value: "x".repeat(2048) },
          })),
        },
      });
      await tools.run(flushTelemetry);
    }
    expect(tools.resolve(exportHealth)).toEqual({ kind: "idle", pending: 0, dropped: 0 });
  } finally {
    stop.abort();
    await tools.closed;
    await receiver.close();
  }
});

test("telemetry sends through the scope-bound HTTP backend", async () => {
  const receiver = await new Receiver().start();
  const stop = new AbortController();
  const tools = createScope({
    signal: stop.signal,
    extensions: [telemetry],
    tags: [
      telemetrySettings({
        side: "ssr",
        service: "test-start",
        level: "info",
        traces: `${receiver.url}/unused`,
        logs: `${receiver.url}/unused`,
      }),
      telemetryBackend((_input, init) => fetch(`${receiver.url}/selected`, init)),
    ],
  });
  try {
    await tools.ready;
    tools.run(ingestTelemetry, {
      input: {
        traces: [],
        logs: [{ time: 1, level: 30, msg: "bound backend", service: "test-start", side: "ssr" }],
      },
    });
    await tools.run(flushTelemetry);
    expect(receiver.requests.map((request) => request.path)).toEqual(["/selected"]);
  } finally {
    stop.abort();
    await tools.closed;
    await receiver.close();
  }
});
