import { afterEach, expect, test } from "bun:test";

import { createScope, data, operation } from "@tinker/core";
import { z } from "zod";

import { memory } from "~/components/memory";
import type { Streams } from "~/components/protocol";
import { remoteData } from "~/components/remote-data";

import { sseClient, sseServer } from "./support/sse";

const sse = { client: sseClient.client, server: sseServer.server };

// F35: one write changes two keys. Does a client ever see one key changed without the other?

const closers: Array<() => unknown> = [];

afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

async function torn(streams: Streams, kind: "memory" | "sse") {
  const todos = data({ initial: [] as string[] });
  const activity = data({ initial: [] as string[] });
  const board = remoteData({ todos, activity });
  const add = operation({
    label: "add",
    input: z.string(),
    depends: { list: todos.controller, log: activity.controller },
    run: async ({ list, log }, { input }) => (
      list.set([...list.get(), input]),
      log.set([...log.get(), `added ${input}`])
    ),
  });
  const transport = sse.server({ base: "/api", services: [board] });
  const server = createScope({
    capsules: [board({ serve: true }), transport, memory.server({ services: [board] })],
  });
  await server.ready;
  closers.push(() => server.close());
  const handle = server.resolve(transport);
  const bun = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: async (r) => (await handle(r, server)) ?? new Response(null, { status: 404 }),
  });
  closers.push(() => bun.stop(true));
  const client = createScope({
    capsules: [
      kind === "memory"
        ? memory.client({ peer: server, streams })
        : sse.client({ base: `http://localhost:${bun.port}/api`, streams }),
      board({ read: kind === "memory" ? memory.client : sse.client }),
    ],
  });
  await client.ready;
  closers.push(() => client.close());
  await new Promise((r) => setTimeout(r, 30)); // the watches are open
  // Each time either key changes, the two must agree: n todos, n activity lines.
  let seen = 0;
  let apart = 0;
  // Read as React does: a store change schedules a render; the render reads after this task's
  // microtasks. So the check reads in a microtask, not inside the set.
  const check = () =>
    queueMicrotask(() => {
      seen++;
      if (
        client.resolve(board.todos).get().length !== client.resolve(board.activity).get().length
      ) {
        apart++;
      }
    });
  client.resolve(board.todos).watch(check);
  client.resolve(board.activity).watch(check);
  for (let i = 0; i < 20; i++) {
    await server.run(add, { input: String(i) });
    await new Promise((r) => setTimeout(r, 2));
  }
  await new Promise((r) => setTimeout(r, 50));

  expect(client.resolve(board.todos).get().length).toBe(20);
  return { seen, apart };
}

test("SSE, each stream: the two keys arrive apart", async () => {
  const out = await torn("each", "sse");
  console.log("sse each:", JSON.stringify(out));
  expect(out.apart).toBeGreaterThan(0);
});

test("SSE, one stream: one write's keys arrive in one frame and are set together", async () => {
  const out = await torn("one", "sse");
  console.log("sse one:", JSON.stringify(out));
  expect(out.apart).toBe(0);
});

test("memory, one stream: together too", async () => {
  expect((await torn("one", "memory")).apart).toBe(0);
});
