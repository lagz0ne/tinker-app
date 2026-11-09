import { createScope, operation } from "@tinker/core";
import type { Observe } from "@tinker/core";
import { afterAll, beforeEach, expect, test } from "vite-plus/test";

import { routes } from "~/components/requests/index.server";

import { api } from "@/api";
import { greetHere } from "@/backend/greet";

import { listen, wsClient as tab, wsServer as server } from "./support/ws";

const shape = /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/;
const remote = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7" };
const valid = `00-${remote.traceId}-${remote.spanId}-01`;

/** Bad headers: each one is ignored, so the request starts a fresh trace. */
const malformed = [
  "",
  "garbage",
  valid.toUpperCase(),
  `ff-${remote.traceId}-${remote.spanId}-01`,
  `01-${remote.traceId}-${remote.spanId}-01`,
  `00-${"0".repeat(32)}-${remote.spanId}-01`,
  `00-${remote.traceId}-${"0".repeat(16)}-01`,
  `00-${remote.traceId.slice(2)}-${remote.spanId}-01`,
  `${valid}-extra`,
];

const echo = operation({ label: "trace.echo", run: () => ({ ok: true }) });

const serverSpans: Observe.Span[] = [];
const tabSpans: Observe.Span[] = [];
/** The meta of each message the clients send, read off the socket. */
const sent: Map<string, string>[] = [];
const Real = globalThis.WebSocket;

globalThis.WebSocket = class extends Real {
  override send(frame: string) {
    for (const m of JSON.parse(frame)) sent.push(new Map(Object.entries(m.m ?? {})));
    super.send(frame);
  }
} as typeof WebSocket;

const stop = new AbortController();

const backend = await createScope({
  observe: { export: (span) => void serverSpans.push(span) },
  capsules: [
    api({ implement: { greet: greetHere } }),
    server.server({ path: "/rpc", services: [api] }),
    routes({ stop: stop.signal, table: { "GET /echo": echo } }),
  ],
}).ready;

const table = backend.resolve(routes);
const { bun, url } = listen(backend, [server.server]);

/** One raw frame with this meta; the first answer back. */
const raw = async (meta: Record<string, string>, base = `${url}/rpc`) => {
  const socket = new Real(base);
  const answer = await new Promise<{ t?: string; e?: number }>((done) => {
    socket.onopen = () =>
      socket.send(JSON.stringify([{ i: 1, a: "greet", t: '{"name":"fresh"}', m: meta }]));
    socket.onmessage = (e) => done(JSON.parse(String(e.data))[0]);
  });

  socket.close();
  return answer;
};

const browser = await createScope({
  observe: { export: (span) => void tabSpans.push(span) },
  capsules: [tab.client({ url: `${url}/rpc` }), api({ remote: tab.client })],
}).ready;

beforeEach(() => {
  serverSpans.length = 0;
  tabSpans.length = 0;
  sent.length = 0;
});

afterAll(async () => {
  await browser.close();
  await bun.stop(true);
  await backend.close();
  globalThis.WebSocket = Real;
});

const named = (spans: Observe.Span[], name: string) => {
  const found = spans.filter((span) => span.name === name);
  expect(found).toHaveLength(1);
  return found[0]!;
};

test("a client call's server spans join the client's trace, under the transport's own span", async () => {
  expect(await browser.run(api.greet, { input: { name: "Duke" } })).toEqual({
    text: "Hello, Duke.",
  });

  const call = named(tabSpans, "greet");
  const request = named(tabSpans, "ws.send");
  const root = named(serverSpans, "ws.serve");
  const work = named(serverSpans, "greet.here");
  expect([root.traceId, work.traceId, request.traceId]).toEqual([
    call.traceId,
    call.traceId,
    call.traceId,
  ]);
  // As OTel HTTP client spans: the server's root is the child of the span that sent the request.
  expect(root.parentSpanId).toBe(request.spanId);
  expect(root.spanId).not.toBe(request.spanId);
  expect(work.sampled).toBe(true);
});

test("the client sends a W3C traceparent with its own span ids and sampled flag", async () => {
  await browser.run(api.greet, { input: { name: "Duke" } });
  const request = named(tabSpans, "ws.send");
  const header = sent[0]?.get("traceparent");

  expect(header).toMatch(shape);
  expect(header).toBe(`00-${request.traceId}-${request.spanId}-01`);

  sent.length = serverSpans.length = tabSpans.length = 0;
  const unsampled = browser.createSession({
    trace: { traceId: remote.traceId, parentSpanId: remote.spanId, sampled: false },
  });
  await unsampled.run(api.greet, { input: { name: "quiet" } });
  await unsampled.close();

  const quiet = named(tabSpans, "ws.send");
  expect(sent[0]?.get("traceparent")).toBe(`00-${remote.traceId}-${quiet.spanId}-00`);
  const root = named(serverSpans, "ws.serve");
  expect(root.traceId).toBe(remote.traceId);
  expect(root.parentSpanId).toBe(quiet.spanId);
  expect(named(serverSpans, "greet.here").sampled).toBe(false);
});

test("a client with observation off sends no traceparent", async () => {
  const dark = await createScope({
    capsules: [tab.client({ url: `${url}/rpc` }), api({ remote: tab.client })],
  }).ready;
  await dark.run(api.greet, { input: { name: "dark" } });
  await dark.close();

  expect(sent[0]?.has("traceparent")).toBe(false);
  expect(named(serverSpans, "ws.serve").parentSpanId).toBeUndefined();
});

test("routes: a request with a valid traceparent gives a route span that is its child", async () => {
  const response = await table(
    new Request("http://tinker/echo", { headers: { traceparent: valid } }),
    backend,
  );

  expect(response?.status).toBe(200);
  const span = named(serverSpans, "trace.echo");
  expect(span.traceId).toBe(remote.traceId);
  expect(span.parentSpanId).toBe(remote.spanId);
  expect(span.sampled).toBe(true);
});

test("a missing or malformed traceparent starts a fresh trace; the request still answers 200", async () => {
  for (const header of [undefined, ...malformed]) {
    const headers: Record<string, string> = header === undefined ? {} : { traceparent: header };

    serverSpans.length = 0;
    const route = await table(new Request("http://tinker/echo", { headers }), backend);
    expect(route?.status).toBe(200);
    const routeSpan = named(serverSpans, "trace.echo");
    expect(routeSpan.traceId).not.toBe(remote.traceId);
    expect(routeSpan.parentSpanId).toBeUndefined();

    serverSpans.length = 0;
    const call = await raw(headers);
    expect(call.t).toBe('{"ok":true,"value":{"text":"Hello, fresh."}}');
    const callSpan = named(serverSpans, "ws.serve");
    expect(callSpan.traceId).not.toBe(remote.traceId);
    expect(callSpan.parentSpanId).toBeUndefined();
  }
});

test("ws: a message after the root closed answers 503, it does not reject", async () => {
  const closing = await createScope({
    capsules: [
      api({ implement: { greet: greetHere } }),
      server.server({ path: "/rpc", services: [api] }),
    ],
  }).ready;

  const late = listen(closing, [server.server]);
  await closing.close();

  expect((await raw({ traceparent: valid }, `${late.url}/rpc`)).e).toBe(503);
  await late.bun.stop(true);
});

test("routes: a request after the root closed answers 500, it does not reject", async () => {
  const closing = await createScope({
    capsules: [routes({ stop: new AbortController().signal, table: { "GET /echo": echo } })],
  }).ready;

  const answer = closing.resolve(routes);
  await closing.close();

  const response = await answer(new Request("http://tinker/echo"), closing);
  expect(response?.status).toBe(500);
});
