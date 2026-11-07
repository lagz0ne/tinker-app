import { afterEach, expect, test } from "bun:test";

import { createScope, LEVELS } from "@tinker/core";
import type { Observe } from "@tinker/core";

import { keepDates } from "./fixtures/todo/codec";
import { api, board } from "./fixtures/todo/contracts";
import { addTodo, joinPresence, removeTodo, signedIn, toggleTodo } from "./fixtures/todo/data";
import { listen, wsClient, wsServer } from "./support/ws";

// What the traces and logs show today, over SSE. Each test states a fact; a finding is marked.

const closers: Array<() => unknown> = [];

afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

const recorder = () => {
  const spans: Observe.Span[] = [];
  const logs: Observe.Log[] = [];
  return {
    spans,
    logs,
    observe: {
      export: (s: Observe.Span) => void spans.push(s),
      log: (l: Observe.Log) => void logs.push(l),
    },
  };
};

const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

async function boot() {
  const srv = recorder();
  const transport = wsServer.server({ path: "/api", codec: keepDates, services: [board, api] });
  const server = createScope({
    observe: srv.observe,
    capsules: [
      board({ serve: true, onStart: [signedIn] }),
      api({
        onStart: [signedIn],
        implement: {
          "todo.add": addTodo,
          "todo.toggle": toggleTodo,
          "todo.remove": removeTodo,
          "presence.join": joinPresence,
        },
      }),
      transport,
    ],
  });
  await server.ready;
  closers.push(() => server.close());
  const { bun, url } = listen(server, [transport]);
  closers.push(() => bun.stop(true));
  const join = async (who: string) => {
    const seen = recorder();
    const client = createScope({
      observe: seen.observe,
      capsules: [
        wsClient.client({
          url: `${url}/api`,
          codec: keepDates,
          headers: { cookie: `sid=${who}` },
        }),
        board({ read: wsClient.client }),
        api({ remote: wsClient.client }),
      ],
    });
    await client.ready;
    closers.push(() => client.close());
    return { client, seen };
  };

  return { srv, join };
}

const names = (spans: Observe.Span[]) => spans.map((s) => s.name);
const since = <T>(list: T[], from: number) => list.slice(from);

test("a call is one trace across both sides", async () => {
  const { srv, join } = await boot();
  const { client, seen } = await join("duke");
  const [c0, s0] = [seen.spans.length, srv.spans.length];
  await client.run(api["todo.add"], { input: { title: "Trace me" } });
  await tick();
  const mine = since(seen.spans, c0).filter((s) => s.name !== "remoteData.receive"); // pushes: the next test
  const theirs = since(srv.spans, s0).filter((s) => s.kind === "operation");

  expect(names(mine).sort()).toEqual(["todo.add", "ws.call", "ws.send"]);
  const [root] = theirs.filter((s) => s.name === "ws.serve");
  expect(theirs.every((s) => s.traceId === mine[0]!.traceId)).toBe(true);
  // O1 fixed: the transport sends its own span, so the server's parent is the request (OTel HTTP).
  expect(root!.parentSpanId).toBe(mine.find((s) => s.name === "ws.send")!.spanId);
  // O5: the route table sends todo.add straight to rpc; remoteData.answer no longer runs.
  expect(names(theirs).sort()).toEqual([
    "remoteData.send",
    "remoteData.send",
    "rpc.answer",
    "signedIn",
    "todo.add.do",
    "ws.serve",
  ]);
});

test("O2 fixed: a push is a send span in the writer's trace, linked from each receiver", async () => {
  const { srv, join } = await boot();
  const duke = await join("duke");
  const ann = await join("ann");
  await tick(); // both watch streams open, so the write has 2 watchers
  const [d0, a0, s0] = [duke.seen.spans.length, ann.seen.spans.length, srv.spans.length];
  await ann.client.run(api["todo.add"], { input: { title: "From ann" } });
  await tick();
  expect(
    duke.client
      .resolve(board.todos)
      .get()
      .map((t) => t.title),
  ).toEqual(["From ann"]);
  const call = since(ann.seen.spans, a0).find((s) => s.name === "todo.add")!;

  // Server: one producer span per written basket, in Ann's trace (OTel messaging "send").
  const sends = since(srv.spans, s0).filter((s) => s.name === "remoteData.send");
  const topics = sends.map((s) => String(s.attributes["messaging.destination.name"]));
  expect(topics.sort((a, b) => a.localeCompare(b))).toEqual(["activity", "todos"]);
  expect(
    sends.every(
      (s) => s.traceId === call.traceId && s.attributes["messaging.batch.message_count"] === 2,
    ),
  ).toBe(true);

  // Duke: one process span per push, in its own trace, with a link to the send that caused it.
  const got = since(duke.seen.spans, d0).filter((s) => s.name === "remoteData.receive");
  const links = got.map((s) => s.events.find((e) => e.name === "link")?.attributes.traceparent);
  const byText = (a: unknown, b: unknown) => String(a).localeCompare(String(b));
  expect(links.sort(byText)).toEqual(
    sends.map((s) => `00-${s.traceId}-${s.spanId}-01`).sort(byText),
  );
  expect(got.every((s) => s.traceId !== call.traceId)).toBe(true);
  expect(since(duke.seen.logs, 0).some((l) => l.message === "remoteData.receive")).toBe(true); // Core's debug line
});

test("finding O3: a basket watch is one trace per client life; a normal close marks it failed", async () => {
  const { join } = await boot();
  const { client, seen } = await join("duke");

  expect(names(seen.spans)).not.toContain("ws.watch"); // still open: not exported yet
  await client.close();
  const watches = seen.spans.filter((s) => s.name === "ws.watch");
  expect(watches.length).toBe(3); // one per basket, each its own trace
  expect(new Set(watches.map((s) => s.traceId)).size).toBe(3);
  expect(watches.every((s) => s.status === "failed")).toBe(true);
  expect(String(watches[0]!.error)).toContain("scope closed");
});

test("O4 gone: a domain outcome is output, so nothing logs at error on either side", async () => {
  const { srv, join } = await boot();
  const { client, seen } = await join("duke");
  const [cl0, sl0] = [seen.logs.length, srv.logs.length];

  expect(await client.run(api["todo.toggle"], { input: { id: "nope" } })).toEqual({
    kind: "gone",
    id: "nope",
  });
  await tick();
  const errors = [...since(seen.logs, cl0), ...since(srv.logs, sl0)].filter(
    (l) => l.level >= LEVELS.error,
  );
  expect(errors).toEqual([]);
});
