import { afterAll, beforeEach, expect, test } from "bun:test";

import { createScope, operation } from "@tinker/core";
import type { Observe } from "@tinker/core";

import { routes } from "~/components/requests/index.server";
import { rpc as tab } from "~/components/rpc";
import { rpc as server } from "~/components/rpc/index.server";
import type { Providers } from "~/components/rpc/index.server";

import { greet } from "@/api/greet";
import { greetHere } from "@/backend/greet";

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

const api = { greet };
const provide = { greet: greetHere } satisfies Providers<typeof api>;

const serverSpans: Observe.Span[] = [];
const tabSpans: Observe.Span[] = [];
const sent: Headers[] = [];

const stop = new AbortController();

const backend = createScope({
  observe: { export: (span) => void serverSpans.push(span) },
  capsules: [
    server.server({ api, provide }),
    routes({ stop: stop.signal, table: { "GET /echo": echo } }),
  ],
});

await backend.ready;
const [calls, table] = [backend.resolve(server.server), backend.resolve(routes)];

/** The tab's send goes straight to the server root's fetch: no network. */
const send = async (url: string | URL | Request, init?: RequestInit) => {
  sent.push(new Headers(init?.headers));
  return (await calls(new Request(url, init), backend)) ?? new Response(null, { status: 404 });
};

const browser = createScope({
  observe: { export: (span) => void tabSpans.push(span) },
  capsules: [
    tab.client({
      api,
      base: "http://tinker/rpc",
      send,
    }),
  ],
});

await browser.ready;

beforeEach(() => {
  serverSpans.length = 0;
  tabSpans.length = 0;
  sent.length = 0;
});

afterAll(async () => {
  await browser.close();
  await backend.close();
});

const named = (spans: Observe.Span[], name: string) => {
  const found = spans.filter((span) => span.name === name);
  expect(found).toHaveLength(1);
  return found[0]!;
};

test("a tab call's server span joins the tab's trace, as the tab span's child", async () => {
  expect(await browser.run(greet, { input: { name: "Duke" } })).toEqual({ text: "Hello, Duke." });

  const tabSpan = named(tabSpans, "greet");
  const serverSpan = named(serverSpans, "greet.here");
  expect(serverSpan.traceId).toBe(tabSpan.traceId);
  expect(serverSpan.parentSpanId).toBe(tabSpan.spanId);
  expect(serverSpan.spanId).not.toBe(tabSpan.spanId);
  expect(serverSpan.sampled).toBe(true);
});

test("the tab sends a W3C traceparent with its own span ids and sampled flag", async () => {
  await browser.run(greet, { input: { name: "Duke" } });
  const tabSpan = named(tabSpans, "greet");
  const header = sent[0]?.get("traceparent");

  expect(header).toMatch(shape);
  expect(header).toBe(`00-${tabSpan.traceId}-${tabSpan.spanId}-01`);

  sent.length = serverSpans.length = tabSpans.length = 0;
  const unsampled = browser.createSession({
    trace: { traceId: remote.traceId, parentSpanId: remote.spanId, sampled: false },
  });
  await unsampled.run(greet, { input: { name: "quiet" } });
  await unsampled.close();

  const quiet = named(tabSpans, "greet");
  expect(sent[0]?.get("traceparent")).toBe(`00-${remote.traceId}-${quiet.spanId}-00`);
  const serverSpan = named(serverSpans, "greet.here");
  expect(serverSpan.traceId).toBe(remote.traceId);
  expect(serverSpan.parentSpanId).toBe(quiet.spanId);
  expect(serverSpan.sampled).toBe(false);
});

test("a tab with observation off sends no traceparent", async () => {
  const dark = createScope({
    capsules: [
      tab.client({
        api,
        base: "http://tinker/rpc",
        send,
      }),
    ],
  });
  await dark.ready;
  await dark.run(greet, { input: { name: "dark" } });
  await dark.close();

  expect(sent[0]?.has("traceparent")).toBe(false);
  expect(named(serverSpans, "greet.here").parentSpanId).toBeUndefined();
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
    const call = await calls(
      new Request("http://tinker/rpc/greet", {
        method: "POST",
        body: JSON.stringify({ name: "fresh" }),
        headers,
      }),
      backend,
    );
    expect(call?.status).toBe(200);
    const callSpan = named(serverSpans, "greet.here");
    expect(callSpan.traceId).not.toBe(remote.traceId);
    expect(callSpan.parentSpanId).toBeUndefined();
  }
});
