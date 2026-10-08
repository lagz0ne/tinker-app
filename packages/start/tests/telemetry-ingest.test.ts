import { createScope } from "@tinker/core";
import { expect, test } from "vite-plus/test";
import { httpBackend } from "../src/backend/http-backend";
import { backendStop, requestStop } from "../src/backend/lifetime";
import { env } from "../src/env";
import {
  browserTelemetry,
  receiveTelemetry,
  telemetryEndpoint,
  telemetryOrigin,
} from "../src/parts/telemetry/ingest.server";
import { flushTelemetry } from "../src/parts/telemetry/observer";
import { telemetry as serverPart } from "../src/parts/telemetry/on.server";
import type { Telemetry } from "../src/parts/telemetry/records";

const empty: Telemetry.Batch = { traces: [], logs: [] };

const tabSpan: Telemetry.Span = {
  side: "browser",
  traceId: "1".repeat(32),
  spanId: "2".repeat(16),
  flags: 1,
  name: "click",
  kind: 1,
  startTimeUnixNano: "1",
  endTimeUnixNano: "2",
  attributes: [],
  events: [],
  status: { code: 1 },
};

const browserLog = (msg: string): Telemetry.Log => ({
  time: 1,
  level: 30,
  msg,
  side: "browser",
  service: "tab",
});

/**
 * A POST to the ingest route, as a tab sends it unless a field says otherwise.
 * @param row - From a test's table; why: the one header or body that differs.
 */
function post(row: {
  url?: string;
  origin?: string;
  type?: string;
  length?: string;
  body?: string | Uint8Array<ArrayBuffer> | null;
}) {
  const headers = new Headers({
    origin: row.origin ?? "http://localhost",
    "content-type": row.type ?? "application/json; charset=utf-8",
  });
  if (row.length) headers.set("content-length", row.length);
  return new Request(row.url ?? "http://localhost/api/telemetry", {
    method: "POST",
    headers,
    body: row.body === null ? null : (row.body ?? JSON.stringify(empty)),
  });
}

test("receiveTelemetry takes a plain batch and hands it to the telemetry root", async () => {
  const accepted: Telemetry.Batch[] = [];
  const stop = new AbortController();
  const root = createScope({
    tags: [
      backendStop(stop.signal),
      requestStop(stop.signal),
      browserTelemetry((batch) => {
        accepted.push(batch);
      }),
    ],
  });
  expect(root.settle(receiveTelemetry, { rawInput: empty })).toEqual({
    status: "success",
    value: undefined,
  });
  expect(accepted).toEqual([empty]);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("receiveTelemetry raises Cancelled once the backend or the request stops", async () => {
  const backend = new AbortController();
  const request = new AbortController();
  const root = createScope({
    tags: [
      backendStop(backend.signal),
      browserTelemetry(() => expect.unreachable("a stopped request must not ingest")),
    ],
  });
  request.abort();
  const late = await root.settle(receiveTelemetry, {
    rawInput: empty,
    tags: requestStop(request.signal),
  });
  expect(late).toMatchObject({ status: "failed", error: { kind: "Cancelled", payload: {} } });
  backend.abort();
  const closing = await root.settle(receiveTelemetry, {
    rawInput: empty,
    tags: requestStop(new AbortController().signal),
  });
  expect(closing).toMatchObject({ status: "failed", error: { kind: "Cancelled" } });
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("the ingest route answers each case with its status, and only a good batch is taken", async () => {
  const stop = new AbortController();
  const accepted: Telemetry.Batch[] = [];
  const root = createScope({
    tags: [
      telemetryOrigin("http://localhost"),
      backendStop(stop.signal),
      requestStop(new AbortController().signal),
      browserTelemetry((batch) => {
        accepted.push(batch);
      }),
    ],
  });
  const good = { traces: [], logs: [browserLog("from a tab")] };
  const cases = [
    { name: "good batch", body: JSON.stringify(good), status: 202 },
    { name: "bad origin", origin: "http://other.test", status: 403 },
    { name: "wrong type", type: "text/plain", status: 415 },
    { name: "too large header", length: "65537", status: 413 },
    { name: "too large body", body: " ".repeat(65_537), status: 413 },
    { name: "bad body", body: "{", status: 400 },
    {
      name: "not UTF-8 inside a message",
      body: new TextEncoder()
        .encode(JSON.stringify({ traces: [], logs: [browserLog("~")] }))
        .map((byte) => (byte === 0x7e ? 0xff : byte)),
      status: 400,
    },
    { name: "bad shape", body: '{"logs":[],"traces":[],"extra":true}', status: 400 },
    {
      name: "server record",
      body: JSON.stringify({ traces: [], logs: [{ ...browserLog("x"), side: "server" }] }),
      status: 400,
    },
    {
      name: "65 records",
      body: JSON.stringify({ traces: [], logs: Array.from({ length: 65 }, () => good.logs[0]) }),
      status: 400,
    },
    { name: "no body", body: null, status: 400 },
    {
      name: "a server span",
      body: JSON.stringify({ traces: [{ ...tabSpan, side: "server" }], logs: [] }),
      status: 400,
    },
    { name: "a tab's span", body: JSON.stringify({ traces: [tabSpan], logs: [] }), status: 202 },
    { name: "a length of 64 KiB", length: "65536", body: JSON.stringify(good), status: 202 },
    { name: "a body of 64 KiB", body: JSON.stringify(good).padEnd(65_536), status: 202 },
    { name: "closed backend", closed: true, status: 503 },
  ];
  for (const row of cases) {
    if (row.closed) stop.abort();
    const session = root.createSession();
    const response = await session.resolve(telemetryEndpoint).answer(post(row));
    expect(
      { status: response.status, headers: [...response.headers], body: await response.text() },
      row.name,
    ).toEqual({
      status: row.status,
      headers: row.status === 202 ? [["cache-control", "no-store"]] : [],
      body: "",
    });
    expect((await session.close({ graceful: true })).status).toBe("success");
  }
  expect(accepted).toEqual([good, { traces: [tabSpan], logs: [] }, good, good]);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("with no origin bound, the route expects the request's own; a preview host's is https", async () => {
  const stop = new AbortController();
  const root = createScope({
    tags: [backendStop(stop.signal), requestStop(stop.signal), browserTelemetry(() => {})],
  });
  const replies = [
    { url: "http://127.0.0.1:4318/api/telemetry", origin: "http://127.0.0.1:4318" },
    {
      url: "http://app.preview.tini.works/api/telemetry",
      origin: "https://app.preview.tini.works",
    },
    { url: "http://app.preview.tini.works/api/telemetry", origin: "http://app.preview.tini.works" },
    { url: "http://app.example/api/telemetry", origin: "https://app.example" },
    {
      url: "http://app.preview.tini.works:8080/api/telemetry",
      origin: "http://app.preview.tini.works:8080",
    },
  ];
  const statuses = [];
  for (const row of replies) {
    const session = root.createSession();
    statuses.push((await session.resolve(telemetryEndpoint).answer(post(row))).status);
    expect((await session.close({ graceful: true })).status).toBe("success");
  }
  expect(statuses).toEqual([202, 202, 403, 403, 202]);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a bound public origin is the one the route expects", async () => {
  const stop = new AbortController();
  const root = createScope({
    tags: [
      telemetryOrigin("https://shop.example/any/path"),
      backendStop(stop.signal),
      requestStop(stop.signal),
      browserTelemetry(() => {}),
    ],
  });
  const session = root.createSession();
  const endpoint = session.resolve(telemetryEndpoint);
  expect((await endpoint.answer(post({ origin: "https://shop.example" }))).status).toBe(202);
  expect((await endpoint.answer(post({ origin: "http://localhost" }))).status).toBe(403);
  expect((await session.close({ graceful: true })).status).toBe("success");
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("closing the scope cancels an unfinished request body, and the route answers 503", async () => {
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
  const root = createScope({
    tags: [
      backendStop(stop.signal),
      requestStop(new AbortController().signal),
      browserTelemetry(() => expect.unreachable("a cut body must not ingest")),
    ],
  });
  const work = root.resolve(telemetryEndpoint).answer(request);
  await entered.promise;
  stop.abort();
  expect((await work).status).toBe(503);
  expect(cancelled).toBe(true);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a body that fails to read fails the reply, as the route's own error", async () => {
  const torn = new Error("torn");
  const request = new Request(
    "http://localhost/api/telemetry",
    Object.assign(
      {
        method: "POST",
        headers: { origin: "http://localhost", "content-type": "application/json" },
        body: new ReadableStream({
          pull(controller) {
            controller.error(torn);
          },
        }),
      },
      { duplex: "half" },
    ),
  );
  const stop = new AbortController();
  const root = createScope({
    tags: [backendStop(stop.signal), requestStop(stop.signal), browserTelemetry(() => {})],
  });
  await expect(root.resolve(telemetryEndpoint).answer(request)).rejects.toBe(torn);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("an ingest that fails, not by a stop, fails the reply", async () => {
  const lost = new Error("queue lost");
  const stop = new AbortController();
  const root = createScope({
    tags: [
      backendStop(stop.signal),
      requestStop(stop.signal),
      browserTelemetry(() => {
        throw lost;
      }),
    ],
  });
  await expect(root.resolve(telemetryEndpoint).answer(post({}))).rejects.toBe(lost);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("on the server, a tab's batch joins the telemetry root under the server's service", async () => {
  const sent: string[] = [];
  const tools = createScope({
    extensions: serverPart.extensions,
    tags: [
      serverPart.tags,
      env({ OTEL_SERVICE_NAME: "shop", VICTORIA_LOGS_URL: "http://storage.test/logs" }),
      httpBackend(async (_input, init) => {
        sent.push(typeof init?.body === "string" ? init.body : "");
        return new Response(null);
      }),
    ],
  });
  await tools.ready;
  const stop = new AbortController();
  const app = createScope({
    tags: [backendStop(stop.signal), requestStop(stop.signal), tools.resolve(serverPart.appTags)],
  });
  const batch = { traces: [], logs: [browserLog("from a tab")] };
  expect(app.settle(receiveTelemetry, { rawInput: batch })).toEqual({
    status: "success",
    value: undefined,
  });
  await tools.run(flushTelemetry);
  expect(sent.map((line) => JSON.parse(line))).toEqual([
    { ...browserLog("from a tab"), service: "shop" },
  ]);
  expect(batch.logs[0]?.service).toBe("tab");
  expect((await app.close({ graceful: true })).status).toBe("success");
  expect((await tools.close({ graceful: true })).status).toBe("success");
});

test("the route lets go of the body it read, and the request ends clean", async () => {
  const stop = new AbortController();
  const root = createScope({
    tags: [backendStop(stop.signal), requestStop(stop.signal), browserTelemetry(() => {})],
  });
  const session = root.createSession();
  const request = post({});
  expect((await session.resolve(telemetryEndpoint).answer(request)).status).toBe(202);
  expect(request.body?.locked).toBe(false);
  expect(await session.close({ graceful: true })).toMatchObject({
    status: "success",
    teardownErrors: undefined,
  });
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a refused request never opens its body, and its session ends clean", async () => {
  const stop = new AbortController();
  const root = createScope({
    tags: [backendStop(stop.signal), requestStop(stop.signal), browserTelemetry(() => {})],
  });
  const session = root.createSession();
  const request = post({ origin: "http://other.test" });
  expect((await session.resolve(telemetryEndpoint).answer(request)).status).toBe(403);
  expect(request.body?.locked).toBe(false);
  expect(await session.close({ graceful: true })).toMatchObject({
    status: "success",
    teardownErrors: undefined,
  });
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a body that comes while the backend stops is cancelled unread, and answered 503", async () => {
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulled += 1;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(empty)));
        controller.close();
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
  stop.abort();
  const root = createScope({
    tags: [
      backendStop(stop.signal),
      requestStop(new AbortController().signal),
      browserTelemetry(() => expect.unreachable("a stopped backend must not ingest")),
    ],
  });
  expect((await root.resolve(telemetryEndpoint).answer(request)).status).toBe(503);
  expect([pulled, cancelled]).toEqual([0, true]);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a browser batch split inside UTF-8 text is read from its byte views", async () => {
  const accepted: Telemetry.Batch[] = [];
  const stop = new AbortController();
  const root = createScope({
    tags: [
      backendStop(stop.signal),
      requestStop(stop.signal),
      browserTelemetry((batch) => {
        accepted.push(batch);
      }),
    ],
  });
  const batch = { traces: [], logs: [browserLog("漢😀")] };
  const bytes = new TextEncoder().encode(`xx${JSON.stringify(batch)}yy`);
  const split = bytes.indexOf(0xe6) + 1;
  const chunks = [bytes.subarray(2, split), bytes.subarray(split, bytes.length - 2)];
  const request = new Request(
    "http://localhost/api/telemetry",
    Object.assign(
      {
        method: "POST",
        headers: { origin: "http://localhost", "content-type": "application/json" },
        body: new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
      },
      { duplex: "half" },
    ),
  );
  expect((await root.resolve(telemetryEndpoint).answer(request)).status).toBe(202);
  expect(accepted).toEqual([batch]);
  expect((await root.close({ graceful: true })).status).toBe("success");
});
