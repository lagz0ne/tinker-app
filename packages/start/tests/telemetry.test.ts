import { createScope, operation } from "@tinker/core";
import { makeTestClock } from "@tinker/core/testing";
import { expect, test } from "vite-plus/test";
import { httpBackend } from "../src/backend/http-backend";
import { env } from "../src/env";
import { exportHealth } from "../src/parts/telemetry/health";
import {
  flushTelemetry,
  ingestTelemetry,
  observer,
  telemetryExport,
} from "../src/parts/telemetry/observer";
import { telemetry as off } from "../src/parts/telemetry/off";
import { telemetry as routerPart } from "../src/parts/telemetry/on";
import type { Telemetry } from "../src/parts/telemetry/records";
import { telemetrySettings, telemetrySide } from "../src/parts/telemetry/settings";

/** Storage keys for a test: each send lands in the fake bound as httpBackend. */
const storageEnv = env({
  VICTORIA_TRACES_URL: "http://storage.test/traces",
  VICTORIA_LOGS_URL: "http://storage.test/logs",
  OTEL_SERVICE_NAME: "test-start",
});

/**
 * A storage fake bound as httpBackend: it keeps each request and answers with the next status.
 * @param statuses - From a test; why: the reply status of each request in turn, then 200.
 */
function storage(statuses: number[] = []) {
  const requests: { url: string; body: string; init: RequestInit | undefined }[] = [];
  const backend: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : "not a string";
    requests.push({ url, body: typeof init?.body === "string" ? init.body : "", init });
    return new Response(null, { status: statuses.shift() ?? 200 });
  };
  /** The body of the first request whose URL starts with `prefix`; "" when none came. */
  const bodyOf = (prefix: string) => requests.find(({ url }) => url.startsWith(prefix))?.body ?? "";
  return { requests, backend, bodyOf };
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

const rejected = operation({
  label: "test.telemetry.rejected",
  run: (_deps, { raise }) => raise("Rollback", {}),
});

const levels = operation({
  label: "test.telemetry.levels",
  run: (_deps, ctx) => {
    ctx.log.debug("dropped below info");
    ctx.log.warn("careful");
    ctx.log.error("broken");
  },
});

/**
 * A log record whose JSON is exactly `bytes` long: 1000-character attribute values, then the message.
 * @param bytes - From a test; why: hit a queue bound to the byte.
 */
function sized(bytes: number): Telemetry.Log {
  const attributes: Record<string, string> = {};
  const log = { ...record(""), attributes };
  for (let index = 0; bytes - JSON.stringify(log).length > 2048; index++)
    attributes[`a${index}`] = "x".repeat(1000);
  log.msg = "x".repeat(bytes - JSON.stringify(log).length);
  return log;
}

const record = (msg: string): Telemetry.Log => ({
  time: 1,
  level: 30,
  msg,
  service: "test-start",
  side: "ssr",
});

test("finished spans reach storage as OTLP JSON", async () => {
  const sent = storage();
  const clock = makeTestClock({ now: 1_800_000_000_000 });
  const tools = createScope({
    clock,
    extensions: [telemetryExport],
    tags: [storageEnv, telemetrySide("ssr"), httpBackend(sent.backend)],
  });
  await tools.ready;
  const app = createScope({ clock, observe: tools.resolve(observer) });
  expect(app.run(parent)).toBe("saved");
  expect(app.settle(rejected).status).toBe("failed");
  await tools.run(flushTelemetry);
  const traces = sent.requests.find(({ url }) => url === "http://storage.test/traces");
  expect(traces?.init).toMatchObject({
    method: "POST",
    headers: { "content-type": "application/json" },
    redirect: "error",
  });
  expect(JSON.parse(sent.bodyOf("http://storage.test/traces"))).toEqual({
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "test-start" } },
            { key: "tinker.side", value: { stringValue: "ssr" } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "tinker.start" },
            spans: expect.arrayContaining([
              expect.objectContaining({
                name: "test.telemetry.child",
                parentSpanId: expect.stringMatching(/^[0-9a-f]{16}$/),
                traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
                flags: 1,
                kind: 1,
                startTimeUnixNano: "1800000000000000000",
                endTimeUnixNano: "1800000000000000000",
                status: { code: 1 },
                attributes: [{ key: "tinker.kind", value: { stringValue: "operation" } }],
                events: [
                  {
                    name: "saved",
                    timeUnixNano: "1800000000000000000",
                    attributes: [
                      { key: "count", value: { stringValue: "1" } },
                      { key: "big", value: { stringValue: "42" } },
                      { key: "cycle", value: { stringValue: "[Unserializable]" } },
                    ],
                  },
                ],
              }),
              expect.objectContaining({
                name: "test.telemetry.rejected",
                status: { code: 2, message: expect.stringContaining("Rollback") },
              }),
            ]),
          },
        ],
      },
    ],
  });
  expect((await app.close({ graceful: true })).status).toBe("success");
  expect((await tools.close({ graceful: true })).status).toBe("success");
});

test("log lines reach storage as JSON lines, one per span too", async () => {
  const sent = storage();
  const clock = makeTestClock({ now: 1_800_000_000_000 });
  const tools = createScope({
    clock,
    extensions: [telemetryExport],
    tags: [storageEnv, telemetrySide("ssr"), httpBackend(sent.backend)],
  });
  await tools.ready;
  const app = createScope({ clock, observe: tools.resolve(observer) });
  expect(app.run(parent)).toBe("saved");
  await tools.run(flushTelemetry);
  const logs = sent.requests.find(({ url }) => url.startsWith("http://storage.test/logs?"));
  expect(logs?.url).toBe(
    "http://storage.test/logs?_time_field=time&_msg_field=msg&_stream_fields=service%2Cside",
  );
  expect(logs?.init).toMatchObject({
    method: "POST",
    headers: { "content-type": "application/stream+json" },
    redirect: "error",
  });
  const lines = sent
    .bodyOf("http://storage.test/logs?")
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(lines).toContainEqual({
    level: 30,
    time: 1_800_000_000_000,
    service: "test-start",
    side: "ssr",
    traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
    spanId: expect.stringMatching(/^[0-9a-f]{16}$/),
    attributes: { count: "1", big: "42", cycle: "[Unserializable]" },
    msg: "saved record",
  });
  expect(lines).toContainEqual({
    level: 30,
    time: 1_800_000_000_000,
    service: "test-start",
    side: "ssr",
    traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
    spanId: expect.stringMatching(/^[0-9a-f]{16}$/),
    msg: "core.span",
  });
  expect((await app.close({ graceful: true })).status).toBe("success");
  expect((await tools.close({ graceful: true })).status).toBe("success");
});

test("lines below info are dropped; warn and error keep their level", async () => {
  const sent = storage();
  const tools = createScope({
    extensions: [telemetryExport],
    tags: [storageEnv, telemetrySide("server"), httpBackend(sent.backend)],
  });
  await tools.ready;
  const app = createScope({ observe: tools.resolve(observer) });
  app.run(levels);
  await tools.run(flushTelemetry);
  const lines = sent
    .bodyOf("http://storage.test/logs?")
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(lines.map(({ level, msg, side }) => [level, msg, side])).toEqual([
    [40, "careful", "server"],
    [50, "broken", "server"],
    [30, "core.span", "server"],
  ]);
  expect((await app.close({ graceful: true })).status).toBe("success");
  expect((await tools.close({ graceful: true })).status).toBe("success");
});

test("a span that never ended is sent with its start as its end; long names are cut", async () => {
  const sent = storage();
  const tools = createScope({
    extensions: [telemetryExport],
    tags: [storageEnv, telemetrySide("ssr"), httpBackend(sent.backend)],
  });
  await tools.ready;
  const { export: send } = tools.resolve(observer);
  send?.({
    id: 1,
    parentId: undefined,
    traceId: "1".repeat(32),
    spanId: "2".repeat(16),
    parentSpanId: undefined,
    sampled: false,
    name: "n".repeat(300),
    kind: "manual",
    start: 5,
    end: undefined,
    status: undefined,
    attributes: Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `${"k".repeat(300)}${index}`,
        index === 0 ? "v".repeat(3000) : index,
      ]),
    ),
    events: Array.from({ length: 40 }, (_, index) => ({
      name: "e".repeat(300),
      time: index,
      attributes: Object.fromEntries(
        Array.from({ length: index === 0 ? 40 : 0 }, (_, at) => [`a${at}`, at]),
      ),
    })),
  });
  await tools.run(flushTelemetry);
  const [span] = JSON.parse(sent.bodyOf("http://storage.test/traces")).resourceSpans[0]
    .scopeSpans[0].spans;
  expect([span.name.length, span.flags, span.startTimeUnixNano, span.endTimeUnixNano]).toEqual([
    256,
    0,
    "5000000",
    "5000000",
  ]);
  expect(span.attributes).toHaveLength(32);
  expect(span.attributes[0].key).toHaveLength(256);
  expect(span.attributes.at(-1)).toEqual({ key: "tinker.kind", value: { stringValue: "manual" } });
  expect(span.events).toHaveLength(32);
  expect(span.events[0].name).toHaveLength(256);
  expect(span.attributes[0].value.stringValue).toHaveLength(2048);
  expect(span.events[0].attributes).toHaveLength(31);
  expect(span.events[1]).toEqual({
    name: "e".repeat(256),
    timeUnixNano: "1000000",
    attributes: [],
  });
  expect(span.status).toEqual({ code: 1 });
  expect((await tools.close({ graceful: true })).status).toBe("success");
});

test("a storage failure keeps the business result and retries the retained records", async () => {
  const sent = storage([503, 503]);
  const tools = createScope({
    extensions: [telemetryExport],
    tags: [storageEnv, telemetrySide("ssr"), httpBackend(sent.backend)],
  });
  await tools.ready;
  const app = createScope({ observe: tools.resolve(observer) });
  expect(app.run(child)).toBe("saved");
  await tools.run(flushTelemetry);
  expect(tools.resolve(exportHealth)).toEqual({
    kind: "failed",
    failure: "Telemetry storage did not accept the batch",
    pending: 3,
    dropped: 0,
  });
  await tools.run(flushTelemetry);
  expect(tools.resolve(exportHealth)).toEqual({ kind: "idle", pending: 0, dropped: 0 });
  expect(sent.requests).toHaveLength(4);
  expect((await app.close({ graceful: true })).status).toBe("success");
  expect((await tools.close({ graceful: true })).status).toBe("success");
});

test("only the kind storage refused is kept: accepted traces leave, refused logs stay", async () => {
  const sent = storage([200, 503]);
  const tools = createScope({
    extensions: [telemetryExport],
    tags: [storageEnv, telemetrySide("ssr"), httpBackend(sent.backend)],
  });
  await tools.ready;
  const app = createScope({ observe: tools.resolve(observer) });
  app.run(child);
  await tools.run(flushTelemetry);
  expect(tools.resolve(exportHealth)).toMatchObject({ kind: "failed", pending: 2 });
  expect((await app.close({ graceful: true })).status).toBe("success");
  expect((await tools.close({ graceful: true })).status).toBe("success");
});

test("a storage that cannot be reached counts as a refusal", async () => {
  const tools = createScope({
    extensions: [telemetryExport],
    tags: [
      storageEnv,
      telemetrySide("ssr"),
      httpBackend(async () => {
        throw new TypeError("fetch failed");
      }),
    ],
  });
  await tools.ready;
  tools.run(ingestTelemetry, { input: { traces: [], logs: [record("unsent")] } });
  await tools.run(flushTelemetry);
  expect(tools.resolve(exportHealth)).toMatchObject({ kind: "failed", pending: 1 });
  expect((await tools.close({ graceful: true })).status).toBe("success");
});

test("closing the telemetry root sends the finished records", async () => {
  const sent = storage();
  const tools = createScope({
    extensions: [telemetryExport],
    tags: [storageEnv, telemetrySide("ssr"), httpBackend(sent.backend)],
  });
  await tools.ready;
  const app = createScope({ observe: tools.resolve(observer) });
  app.run(child);
  expect(sent.requests).toEqual([]);
  expect((await app.close({ graceful: true })).status).toBe("success");
  expect((await tools.close({ graceful: true })).status).toBe("success");
  expect(sent.requests.map(({ url }) => new URL(url).pathname)).toEqual(["/traces", "/logs"]);
});

test("a server root sends on its own once a second has passed", async () => {
  const arrived = Promise.withResolvers<string>();
  const clock = makeTestClock();
  const tools = createScope({
    clock,
    extensions: [telemetryExport],
    tags: [
      storageEnv,
      telemetrySide("server"),
      httpBackend(async (input) => {
        arrived.resolve(typeof input === "string" ? input : "not a string");
        return new Response(null);
      }),
    ],
  });
  await tools.ready;
  tools.run(ingestTelemetry, { input: { traces: [], logs: [record("first")] } });
  clock.advance(1000);
  expect(await arrived.promise).toMatch(/^http:\/\/storage\.test\/logs\?/);
  expect((await tools.close({ graceful: true })).status).toBe("success");
});

test("a stuck storage request is aborted by the owned clock during close", async () => {
  const arrived = Promise.withResolvers<void>();
  const clock = makeTestClock();
  const tools = createScope({
    clock,
    extensions: [telemetryExport],
    tags: [
      storageEnv,
      telemetrySide("ssr"),
      httpBackend(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            arrived.resolve();
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      ),
    ],
  });
  await tools.ready;
  const app = createScope({ clock, observe: tools.resolve(observer) });
  app.run(child);
  expect((await app.close({ graceful: true })).status).toBe("success");
  const closing = tools.close({ graceful: true });
  await arrived.promise;
  clock.advance(1500);
  expect((await closing).status).toBe("success");
});

test("a full queue drops records past 512 and reports them; each send stays within 64 KiB", async () => {
  const sent = storage();
  const tools = createScope({
    extensions: [telemetryExport],
    tags: [storageEnv, telemetrySide("ssr"), httpBackend(sent.backend)],
  });
  await tools.ready;
  const batch = { traces: [], logs: Array.from({ length: 64 }, () => record("queued")) };
  for (let index = 0; index < 9; index++) tools.run(ingestTelemetry, { input: batch });
  expect(tools.resolve(exportHealth)).toEqual({ kind: "queued", pending: 512, dropped: 64 });
  expect((await tools.close({ graceful: true })).status).toBe("success");
  expect(sent.requests).toHaveLength(8);
  expect(
    sent.requests.every(({ body }) => new TextEncoder().encode(body).byteLength <= 65_536),
  ).toBe(true);
});

test("a record over 48 KB is dropped; one send takes at most 64 records", async () => {
  const sent = storage();
  const tools = createScope({
    extensions: [telemetryExport],
    tags: [storageEnv, telemetrySide("ssr"), httpBackend(sent.backend)],
  });
  await tools.ready;
  const big = {
    ...record("big"),
    attributes: Object.fromEntries(
      Array.from({ length: 24 }, (_, index) => [`k${index}`, "x".repeat(2048)]),
    ),
  };
  tools.run(ingestTelemetry, { input: { traces: [], logs: [big] } });
  expect(tools.resolve(exportHealth)).toEqual({ kind: "queued", pending: 0, dropped: 1 });
  for (let index = 0; index < 2; index++)
    tools.run(ingestTelemetry, {
      input: { traces: [], logs: Array.from({ length: 40 }, () => record("many")) },
    });
  await tools.run(flushTelemetry);
  expect(sent.bodyOf("http://storage.test/logs?").split("\n")).toHaveLength(64);
  expect(tools.resolve(exportHealth)).toEqual({ kind: "queued", pending: 16, dropped: 1 });
  expect((await tools.close({ graceful: true })).status).toBe("success");
});

test("sent records free the byte budget for later records", async () => {
  const sent = storage();
  const tools = createScope({
    extensions: [telemetryExport],
    tags: [storageEnv, telemetrySide("ssr"), httpBackend(sent.backend)],
  });
  await tools.ready;
  for (let round = 0; round < 40; round += 1) {
    tools.run(ingestTelemetry, {
      input: {
        traces: [],
        logs: Array.from({ length: 8 }, () => ({
          ...record("x".repeat(2048)),
          attributes: { value: "x".repeat(2048) },
        })),
      },
    });
    await tools.run(flushTelemetry);
  }
  expect(tools.resolve(exportHealth)).toEqual({ kind: "idle", pending: 0, dropped: 0 });
  expect((await tools.close({ graceful: true })).status).toBe("success");
});

test("telemetry sends through httpBackend without tracing its own requests", async () => {
  const sent = storage();
  const tools = createScope({
    extensions: [telemetryExport],
    observe: { history: 30 },
    tags: [storageEnv, telemetrySide("ssr"), httpBackend(sent.backend)],
  });
  await tools.ready;
  tools.run(ingestTelemetry, { input: { traces: [], logs: [record("bound backend")] } });
  await tools.run(flushTelemetry);
  expect(sent.requests.map(({ url }) => url)).toEqual([
    "http://storage.test/logs?_time_field=time&_msg_field=msg&_stream_fields=service%2Cside",
  ]);
  const names = tools.spans().map(({ name }) => name);
  expect(names).toContain("telemetry.export");
  expect(names.filter((name) => name.startsWith("http"))).toEqual([]);
  expect((await tools.close({ graceful: true })).status).toBe("success");
});

test("a tab sends its batch to the base's ingest route: same origin, kept alive", async () => {
  const sent = storage([200, 503]);
  const tools = createScope({
    extensions: [telemetryExport],
    tags: [env({}), telemetrySide("browser"), httpBackend(sent.backend)],
  });
  await tools.ready;
  const app = createScope({ observe: tools.resolve(observer) });
  app.run(levels);
  await tools.run(flushTelemetry);
  expect(sent.requests[0]?.url).toBe("/api/telemetry");
  expect(sent.requests[0]?.init).toMatchObject({
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    keepalive: true,
    redirect: "error",
  });
  const batch = JSON.parse(sent.bodyOf("/api/telemetry"));
  expect(batch.traces.map(({ side, name }: Telemetry.Span) => [side, name])).toEqual([
    ["browser", "test.telemetry.levels"],
  ]);
  expect(batch.logs.map(({ side, service, msg }: Telemetry.Log) => [side, service, msg])).toEqual([
    ["browser", "tinker-app", "careful"],
    ["browser", "tinker-app", "broken"],
    ["browser", "tinker-app", "core.span"],
  ]);
  tools.run(ingestTelemetry, {
    input: { traces: [], logs: [{ ...record("refused"), side: "browser" }] },
  });
  await tools.run(flushTelemetry);
  expect(tools.resolve(exportHealth)).toMatchObject({ kind: "failed", pending: 1 });
  expect((await app.close({ graceful: true })).status).toBe("success");
  expect((await tools.close({ graceful: true })).status).toBe("success");
});

test("a tab whose send throws keeps its records for the next send", async () => {
  const tools = createScope({
    extensions: [telemetryExport],
    tags: [
      env({}),
      telemetrySide("browser"),
      httpBackend(async () => {
        throw new TypeError("offline");
      }),
    ],
  });
  await tools.ready;
  const app = createScope({ observe: tools.resolve(observer) });
  app.run(child);
  await tools.run(flushTelemetry);
  expect(tools.resolve(exportHealth)).toMatchObject({ kind: "failed", pending: 3 });
  expect((await app.close({ graceful: true })).status).toBe("success");
  expect((await tools.close({ graceful: true })).status).toBe("success");
});

test("the part reads its three keys once: defaults, set values, and the browser's none", async () => {
  const server = createScope({ tags: [env({}), telemetrySide("server")] });
  expect(server.resolve(telemetrySettings)).toEqual({
    side: "server",
    service: "tinker-app",
    traces: "http://127.0.0.1:10428/insert/opentelemetry/v1/traces",
    logs: "http://127.0.0.1:9428/insert/jsonline",
  });
  expect((await server.close({ graceful: true })).status).toBe("success");
  const set = createScope({ tags: [storageEnv, telemetrySide("ssr")] });
  expect(set.resolve(telemetrySettings)).toEqual({
    side: "ssr",
    service: "test-start",
    traces: "http://storage.test/traces",
    logs: "http://storage.test/logs",
  });
  expect((await set.close({ graceful: true })).status).toBe("success");
  const tab = createScope({ tags: [storageEnv, telemetrySide("browser")] });
  expect(tab.resolve(telemetrySettings)).toEqual({ side: "browser", service: "test-start" });
  expect((await tab.close({ graceful: true })).status).toBe("success");
});

test("a bad storage URL stops the telemetry root at its start, naming each bad key", async () => {
  const tools = createScope({
    extensions: [telemetryExport],
    tags: [
      env({ VICTORIA_TRACES_URL: "not a url", VICTORIA_LOGS_URL: "ftp://logs.test" }),
      telemetrySide("server"),
    ],
  });
  await expect(tools.ready).rejects.toMatchObject({
    kind: "BadSettings",
    payload: { part: "telemetry", keys: ["VICTORIA_TRACES_URL", "VICTORIA_LOGS_URL"] },
  });
  expect((await tools.close({ graceful: true })).status).toBe("failed");
});

test("the router's part records a server render as ssr", async () => {
  const tools = createScope({
    extensions: routerPart.extensions,
    tags: [env({}), routerPart.tags],
  });
  await tools.ready;
  expect(tools.resolve(telemetrySettings).side).toBe("ssr");
  expect(tools.resolve(routerPart.observe)).toMatchObject({ history: 80, level: 30 });
  expect((await tools.close({ graceful: true })).status).toBe("success");
});

test("the off part leaves the telemetry root empty and the app root unobserved", async () => {
  const tools = createScope({ extensions: off.extensions, tags: off.tags });
  await tools.ready;
  expect(tools.resolve(off.observe)).toBeUndefined();
  expect(tools.resolve(off.appTags)).toEqual([]);
  expect((await tools.close({ graceful: true })).status).toBe("success");
});

test("a record of exactly 48,000 bytes is kept; one byte more is dropped", async () => {
  const tools = createScope({
    extensions: [telemetryExport],
    tags: [storageEnv, telemetrySide("ssr"), httpBackend(storage().backend)],
  });
  await tools.ready;
  tools.run(ingestTelemetry, { input: { traces: [], logs: [sized(48_000)] } });
  tools.run(ingestTelemetry, { input: { traces: [], logs: [sized(48_001)] } });
  expect(tools.resolve(exportHealth)).toEqual({ kind: "queued", pending: 1, dropped: 1 });
  expect((await tools.close({ graceful: true })).status).toBe("success");
});

test("the queue holds 1 MiB to the byte, and counts what it holds after a refused send", async () => {
  const tools = createScope({
    extensions: [telemetryExport],
    tags: [storageEnv, telemetrySide("ssr"), httpBackend(storage([503]).backend)],
  });
  await tools.ready;
  const full = [...Array.from({ length: 22 }, () => sized(47_000)), sized(14_576)];
  for (const log of full) tools.run(ingestTelemetry, { input: { traces: [], logs: [log] } });
  expect(tools.resolve(exportHealth)).toEqual({ kind: "queued", pending: 23, dropped: 0 });
  tools.run(ingestTelemetry, { input: { traces: [], logs: [record("past the bound")] } });
  expect(tools.resolve(exportHealth)).toEqual({ kind: "queued", pending: 23, dropped: 1 });
  await tools.run(flushTelemetry);
  tools.run(ingestTelemetry, { input: { traces: [], logs: [record("still past it")] } });
  expect(tools.resolve(exportHealth)).toMatchObject({ kind: "failed", pending: 23, dropped: 2 });
  expect((await tools.close({ graceful: true })).status).toBe("success");
});

test("one send carries at most 48,000 bytes: four 12,000-byte records go, the fifth waits", async () => {
  const sent = storage();
  const tools = createScope({
    extensions: [telemetryExport],
    tags: [storageEnv, telemetrySide("ssr"), httpBackend(sent.backend)],
  });
  await tools.ready;
  const logs = Array.from({ length: 5 }, () => sized(12_000));
  tools.run(ingestTelemetry, { input: { traces: [], logs } });
  await tools.run(flushTelemetry);
  expect(sent.bodyOf("http://storage.test/logs?").split("\n")).toHaveLength(4);
  expect(tools.resolve(exportHealth)).toEqual({ kind: "queued", pending: 1, dropped: 0 });
  expect((await tools.close({ graceful: true })).status).toBe("success");
});

test("while a send runs, the health says sending, and new records wait for the next", async () => {
  const arrived = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<Response>();
  const tools = createScope({
    extensions: [telemetryExport],
    tags: [
      storageEnv,
      telemetrySide("ssr"),
      httpBackend(() => {
        arrived.resolve();
        return reply.promise;
      }),
    ],
  });
  await tools.ready;
  tools.run(ingestTelemetry, { input: { traces: [], logs: [record("first")] } });
  const sending = tools.run(flushTelemetry);
  await arrived.promise;
  expect(tools.resolve(exportHealth)).toEqual({ kind: "sending", pending: 1, dropped: 0 });
  tools.run(ingestTelemetry, { input: { traces: [], logs: [record("second")] } });
  expect(tools.resolve(exportHealth)).toEqual({ kind: "sending", pending: 2, dropped: 0 });
  reply.resolve(new Response(null));
  await sending;
  expect(tools.resolve(exportHealth)).toEqual({ kind: "queued", pending: 1, dropped: 0 });
  expect((await tools.close({ graceful: true })).status).toBe("success");
});

test("after a refused send, new records keep the failed health", async () => {
  const tools = createScope({
    extensions: [telemetryExport],
    tags: [storageEnv, telemetrySide("ssr"), httpBackend(storage([503]).backend)],
  });
  await tools.ready;
  tools.run(ingestTelemetry, { input: { traces: [], logs: [record("refused")] } });
  await tools.run(flushTelemetry);
  tools.run(ingestTelemetry, { input: { traces: [], logs: [record("later")] } });
  expect(tools.resolve(exportHealth)).toEqual({
    kind: "failed",
    failure: "Telemetry storage did not accept the batch",
    pending: 2,
    dropped: 0,
  });
  expect((await tools.close({ graceful: true })).status).toBe("success");
});

test("a queue on a root with no telemetry extension still sends what it holds at close", async () => {
  const sent = storage();
  const root = createScope({
    tags: [storageEnv, telemetrySide("ssr"), httpBackend(sent.backend)],
  });
  root.run(ingestTelemetry, { input: { traces: [], logs: [record("held")] } });
  expect((await root.close({ graceful: true })).status).toBe("success");
  expect(sent.requests).toHaveLength(1);
});

test("closing gives up on storage after 1.5 s; what is left is dropped", async () => {
  const clock = makeTestClock();
  const calls: PromiseWithResolvers<Response>[] = [];
  let arrival = Promise.withResolvers<PromiseWithResolvers<Response>>();
  const tools = createScope({
    clock,
    extensions: [telemetryExport],
    tags: [
      storageEnv,
      telemetrySide("ssr"),
      httpBackend(() => {
        const call = Promise.withResolvers<Response>();
        calls.push(call);
        if (calls.length > 3) return Promise.resolve(new Response(null));
        arrival.resolve(call);
        arrival = Promise.withResolvers();
        return call.promise;
      }),
    ],
  });
  await tools.ready;
  for (let round = 0; round < 4; round++)
    tools.run(ingestTelemetry, {
      input: { traces: [], logs: Array.from({ length: 64 }, () => record("held")) },
    });
  const closing = tools.close({ graceful: true });
  for (let round = 0; round < 3; round++) {
    const call = await arrival.promise;
    clock.advance(600);
    call.resolve(new Response(null));
  }
  expect((await closing).status).toBe("success");
  expect(calls).toHaveLength(3);
});

test("a log line outside any span, and long keys, messages, and errors, are cut", async () => {
  const sent = storage();
  const tools = createScope({
    extensions: [telemetryExport],
    tags: [storageEnv, telemetrySide("server"), httpBackend(sent.backend)],
  });
  await tools.ready;
  const { log, export: send } = tools.resolve(observer);
  log?.({
    time: 7,
    level: 40,
    message: "m".repeat(3000),
    attributes: { ["k".repeat(300)]: "v" },
    span: undefined,
  });
  send?.({
    id: 1,
    parentId: undefined,
    traceId: "1".repeat(32),
    spanId: "2".repeat(16),
    parentSpanId: undefined,
    sampled: true,
    name: "failed",
    kind: "operation",
    start: 1,
    end: 2,
    status: "failed",
    error: "e".repeat(3000),
    attributes: {},
    events: [{ name: "e", time: 1, attributes: { ["a".repeat(300)]: 1 } }],
  });
  await tools.run(flushTelemetry);
  const [line] = sent.bodyOf("http://storage.test/logs?").split("\n");
  expect(JSON.parse(line ?? "")).toEqual({
    level: 40,
    time: 7,
    service: "test-start",
    side: "server",
    attributes: { ["k".repeat(256)]: '"v"' },
    msg: "m".repeat(2048),
  });
  const [span] = JSON.parse(sent.bodyOf("http://storage.test/traces")).resourceSpans[0]
    .scopeSpans[0].spans;
  expect(span.status).toEqual({ code: 2, message: "e".repeat(2048) });
  expect(span.events[0].attributes[0].key).toBe("a".repeat(256));
  expect((await tools.close({ graceful: true })).status).toBe("success");
});

test("a server groups the spans it sends by side: server, browser, then ssr", async () => {
  const sent = storage();
  const tools = createScope({
    extensions: [telemetryExport],
    tags: [storageEnv, telemetrySide("server"), httpBackend(sent.backend)],
  });
  await tools.ready;
  const span = (side: Telemetry.Side, name: string): Telemetry.Span => ({
    side,
    traceId: "1".repeat(32),
    spanId: "2".repeat(16),
    flags: 1,
    name,
    kind: 1,
    startTimeUnixNano: "1",
    endTimeUnixNano: "2",
    attributes: [],
    events: [],
    status: { code: 1 },
  });
  const traces = [span("ssr", "c"), span("browser", "b"), span("server", "a")];
  tools.run(ingestTelemetry, { input: { traces, logs: [] } });
  await tools.run(flushTelemetry);
  expect(sent.requests.map(({ url }) => url)).toEqual(["http://storage.test/traces"]);
  const groups = JSON.parse(sent.bodyOf("http://storage.test/traces")).resourceSpans;
  expect(
    groups.map(
      (group: {
        resource: { attributes: { value: { stringValue: string } }[] };
        scopeSpans: { spans: { name: string; side?: string }[] }[];
      }) => [
        group.resource.attributes[1]?.value.stringValue,
        group.scopeSpans[0]?.spans.map(({ name, side }) => [name, side]),
      ],
    ),
  ).toEqual([
    ["server", [["a", undefined]]],
    ["browser", [["b", undefined]]],
    ["ssr", [["c", undefined]]],
  ]);
  expect(tools.resolve(exportHealth)).toEqual({ kind: "idle", pending: 0, dropped: 0 });
  expect((await tools.close({ graceful: true })).status).toBe("success");
});

test("a trace send that throws keeps the traces; the logs sent beside them leave", async () => {
  const tools = createScope({
    extensions: [telemetryExport],
    tags: [
      storageEnv,
      telemetrySide("server"),
      httpBackend(async (input) => {
        if (input === "http://storage.test/traces") throw new TypeError("fetch failed");
        return new Response(null);
      }),
    ],
  });
  await tools.ready;
  const app = createScope({ observe: tools.resolve(observer) });
  app.run(child);
  await tools.run(flushTelemetry);
  expect(tools.resolve(exportHealth)).toMatchObject({ kind: "failed", pending: 1 });
  expect((await app.close({ graceful: true })).status).toBe("success");
  expect((await tools.close({ graceful: true })).status).toBe("success");
});

test("closing a tab never sends a batch over 32,000 UTF-8 bytes", async () => {
  const sent = storage();
  const tools = createScope({
    extensions: [telemetryExport],
    tags: [storageEnv, telemetrySide("browser"), httpBackend(sent.backend)],
  });
  await tools.ready;
  const log = { ...record("é".repeat(1000)), side: "browser" as const };
  const large = { ...sized(32_000), side: "browser" as const };
  const fitting = { ...sized(31_972), side: "browser" as const };
  tools.run(ingestTelemetry, { input: { traces: [], logs: [large, fitting] } });
  tools.run(ingestTelemetry, {
    input: { traces: [], logs: Array.from({ length: 40 }, () => log) },
  });
  expect((await tools.close({ graceful: true })).status).toBe("success");
  expect(sent.requests.length).toBeGreaterThan(1);
  for (const { body } of sent.requests)
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(32_000);
  expect(sent.requests.flatMap(({ body }) => JSON.parse(body).logs)).toEqual([
    fitting,
    ...Array.from({ length: 40 }, () => log),
  ]);
});
