import { createScope, data, operation, remoteData } from "@tinker/core";
import { memory } from "@tinker/core/testing";
import { afterEach, expect, test } from "vite-plus/test";
import { z } from "zod";

import { listen, wsClient, wsServer } from "./support/ws";

// F35: one write changes two keys. Does a client ever see one key changed without the other?

const closers: Array<() => unknown> = [];

afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

async function torn(kind: "memory" | "ws") {
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
  const transport = wsServer.server({ path: "/api", services: [board] });
  const server = await createScope({
    capsules: [board({ serve: true }), transport, memory.server({ services: [board] })],
  }).ready;
  closers.push(() => server.close());

  const { bun, url } = listen(server, [transport]);
  closers.push(() => bun.stop(true));
  const client = await createScope({
    capsules: [
      kind === "memory" ? memory.client({ peer: server }) : wsClient.client({ url: `${url}/api` }),
      board({ read: kind === "memory" ? memory.client : wsClient.client }),
    ],
  }).ready;
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

test("one socket: one write's keys arrive in one frame and are set together", async () => {
  expect((await torn("ws")).apart).toBe(0);
});

test("memory: together too", async () => {
  expect((await torn("memory")).apart).toBe(0);
});
