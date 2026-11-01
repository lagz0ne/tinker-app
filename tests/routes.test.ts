import { expect, test } from "bun:test";

import { createScope, operation } from "@tinker/core";
import type { Observe } from "@tinker/core";
import { z } from "zod";

import { routes } from "~/components/requests/index.server";

const echo = operation({
  label: "echo",
  input: z.object({ id: z.string(), q: z.string() }),
  run: (_deps, { input }) => input,
});

const empty = operation({ label: "empty", run: () => undefined });
const raw = operation({ label: "raw", run: () => new Response("ok", { status: 201 }) });

const boom = operation({
  label: "boom",
  run: () => {
    throw new Error("boom");
  },
});

const slow = operation({
  label: "slow",
  run: (_deps, { signal }) =>
    new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
});

test("each route reply maps to its HTTP status", async () => {
  const stop = new AbortController();
  const app = createScope({
    capsules: [
      routes({
        stop: stop.signal,
        table: {
          "GET /x/{id}": echo,
          "POST /empty": empty,
          "GET /raw": raw,
          "GET /boom": boom,
          "GET /slow": slow,
        },
      }),
    ],
  });
  await app.ready;
  const fetch = app.resolve(routes);
  const call = (path: string, init?: RequestInit) =>
    fetch(new Request(`http://t${path}`, init), app);

  const ok = await call("/x/7?q=a");
  expect(ok?.status).toBe(200);
  expect(await ok?.json()).toEqual({ id: "7", q: "a" });
  expect((await call("/x/7"))?.status).toBe(400);
  expect((await call("/empty", { method: "POST" }))?.status).toBe(204);
  expect((await call("/raw"))?.status).toBe(201);
  expect((await call("/boom"))?.status).toBe(500);
  expect(await call("/nope")).toBeUndefined();
  expect(await call("/empty")).toBeUndefined();

  const waiting = call("/slow");
  stop.abort();
  expect((await waiting)?.status).toBe(503);

  await app.close();
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Waits up to `ms` for a promise; "late" when it is still pending then: the reply waited. */
const within = <T>(promise: Promise<T>, ms = 1000) =>
  Promise.race([promise, Bun.sleep(ms).then(() => "late" as const)]);

test("an early reply streams while its op runs; the op's span ends after the body ends", async () => {
  const spans: Observe.Span[] = [];
  const more = Promise.withResolvers<void>();
  const stream = operation({
    label: "stream",
    depends: { reply: routes.reply.required },
    run: async ({ reply }) => {
      const opened = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
      const body = new ReadableStream<Uint8Array>({ start: opened.resolve });
      reply(new Response(body, { headers: { "Content-Type": "text/event-stream" } }));

      const writer = await opened.promise;
      writer.enqueue(encoder.encode("data: one\n\n"));

      await more.promise;
      writer.enqueue(encoder.encode("data: two\n\n"));
      writer.close();
    },
  });
  const app = createScope({
    observe: { export: (span) => void spans.push(span) },
    capsules: [routes({ stop: new AbortController().signal, table: { "GET /stream": stream } })],
  });
  await app.ready;
  const answer = app.resolve(routes);
  const http = Bun.serve({
    port: 0,
    fetch: async (r) => (await answer(r, app)) ?? new Response(null, { status: 404 }),
  });

  try {
    const response = await within(fetch(`${http.url}stream`));
    expect(response).toBeInstanceOf(Response);
    if (response === "late") return;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe("data: one\n\n");
    expect(spans.map((span) => span.name)).not.toContain("stream");

    more.resolve();
    let rest = "";
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      rest += decoder.decode(next.value);
    }
    expect(rest).toBe("data: two\n\n");
    for (let i = 0; i < 50 && !spans.some((span) => span.name === "stream"); i++) {
      await Bun.sleep(10);
    }
    const span = spans.find((span) => span.name === "stream");
    expect(span?.status).toBe("ok");
  } finally {
    more.resolve();
    await http.stop(true);
    await app.close();
  }
});

test("an op that replies early and then fails keeps its reply", async () => {
  const spans: Observe.Span[] = [];
  const late = operation({
    label: "late",
    depends: { reply: routes.reply.required },
    run: async ({ reply }) => {
      reply(new Response("sent", { status: 202 }));
      await Bun.sleep(5);
      throw new Error("after the reply");
    },
  });
  const app = createScope({
    observe: { export: (span) => void spans.push(span) },
    capsules: [routes({ stop: new AbortController().signal, table: { "GET /late": late } })],
  });
  await app.ready;

  const response = await within(app.resolve(routes)(new Request("http://t/late"), app));
  expect(response).toBeInstanceOf(Response);
  if (!(response instanceof Response)) return;
  expect(response.status).toBe(202);
  expect(await response.text()).toBe("sent");
  await Bun.sleep(20);
  expect(spans.find((span) => span.name === "late")?.status).toBe("failed");

  await app.close();
});

test("after an early reply, a Response the op returns is dropped and its body cancelled", async () => {
  const cancelled = Promise.withResolvers<unknown>();
  const twice = operation({
    label: "twice",
    depends: { reply: routes.reply.required },
    run: async ({ reply }) => {
      reply(new Response("first", { status: 202 }));
      await Bun.sleep(5);
      return new Response(new ReadableStream({ cancel: (reason) => cancelled.resolve(reason) }));
    },
  });
  const app = createScope({
    capsules: [routes({ stop: new AbortController().signal, table: { "GET /twice": twice } })],
  });
  await app.ready;

  const response = await within(app.resolve(routes)(new Request("http://t/twice"), app));
  expect(response).toBeInstanceOf(Response);
  if (!(response instanceof Response)) return;
  expect(response.status).toBe(202);
  expect(await response.text()).toBe("first");
  expect(await within(cancelled.promise, 200)).not.toBe("late");

  await app.close();
});
