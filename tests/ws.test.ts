import { afterEach, expect, test } from "bun:test";

import { createScope, data, operation } from "@tinker/core";
import { z } from "zod";

import { remoteData } from "~/components/remote-data";
import { channel, rpc } from "~/components/rpc";
import { ws } from "~/components/ws";
import { ws as wsServer } from "~/components/ws/index.server";

import { api } from "@/api";
import { greetHere } from "@/backend/greet";

// One WebSocket per client: calls and watches share it, one frame per tick.

const closers: Array<() => unknown> = [];

afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function serverOf(services: never[], capsules: unknown[], options = {}) {
  const transport = wsServer.server({ path: "/rpc", services, ...options });
  const scope = await createScope({ capsules: [...(capsules as never[]), transport] }).ready;
  closers.push(() => scope.close());

  const { upgrade, websocket } = scope.resolve(transport) as never as {
    upgrade: (r: Request, s: unknown, b: unknown) => Response | null | undefined;
    websocket: never;
  };
  const bun = Bun.serve({
    port: 0,
    idleTimeout: 0,
    websocket,
    fetch: (r, b) => {
      const reply = upgrade(r, scope, b);
      return reply === null ? undefined : (reply ?? new Response(null, { status: 404 }));
    },
  });
  closers.push(() => bun.stop(true));

  return { scope, url: `ws://localhost:${bun.port}/rpc` };
}

test("a call crosses the socket and back", async () => {
  const { url } = await serverOf([api as never], [api({ implement: { greet: greetHere } })]);
  const client = await createScope({ capsules: [ws.client({ url }), api({ remote: ws.client })] })
    .ready;
  closers.push(() => client.close());

  const all = await Promise.all(
    ["a", "b", "c"].map((name) => client.run(api.greet, { input: { name } })),
  );
  expect(all).toEqual([{ text: "Hello, a." }, { text: "Hello, b." }, { text: "Hello, c." }]);
});

test("the calls of one tick go as one frame", async () => {
  const { url } = await serverOf([api as never], [api({ implement: { greet: greetHere } })]);
  const frames: string[] = [];
  const Real = globalThis.WebSocket;
  globalThis.WebSocket = class extends Real {
    override send(d: string) {
      frames.push(d);
      super.send(d);
    }
  } as typeof WebSocket;
  closers.push(() => (globalThis.WebSocket = Real));
  const client = await createScope({ capsules: [ws.client({ url }), api({ remote: ws.client })] })
    .ready;
  closers.push(() => client.close());

  await Promise.all(
    Array.from({ length: 40 }, (_, k) => client.run(api.greet, { input: { name: `n${k}` } })),
  );
  // 40 calls of one tick: two frames (32 + 8), not 40.
  expect(frames.map((f) => JSON.parse(f).length)).toEqual([32, 8]);
});

test("a watch gets pushes; one write's two keys arrive together (F35)", async () => {
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
  const { scope: server, url } = await serverOf([board as never], [board({ serve: true })]);
  const client = await createScope({ capsules: [ws.client({ url }), board({ read: ws.client })] })
    .ready;
  closers.push(() => client.close());
  await tick();

  let apart = 0;
  const check = () =>
    queueMicrotask(() => {
      const [a, b] = [client.resolve(board.todos).get(), client.resolve(board.activity).get()];
      if (a.length !== b.length) apart++;
    });
  client.resolve(board.todos).watch(check);
  client.resolve(board.activity).watch(check);
  for (let i = 0; i < 20; i++) {
    await server.run(add, { input: String(i) });
    await tick(2);
  }
  await tick(50);
  expect(client.resolve(board.todos).get().length).toBe(20);
  expect(apart).toBe(0);
});

test("an upgrade from another origin answers 403", async () => {
  const { url } = await serverOf([api as never], [api({ implement: { greet: greetHere } })]);
  const reply = await fetch(url.replace("ws:", "http:"), {
    headers: { origin: "https://evil.example", upgrade: "websocket", connection: "Upgrade" },
  });
  expect(reply.status).toBe(403);
});

test("a frame of more than 32 messages closes the socket", async () => {
  const { url } = await serverOf([api as never], [api({ implement: { greet: greetHere } })]);
  const socket = new WebSocket(url);
  await new Promise((r) => (socket.onopen = r));

  const closed = new Promise<number>((r) => (socket.onclose = (e) => r(e.code)));
  socket.send(JSON.stringify(Array.from({ length: 33 }, (_, i) => ({ i }))));
  expect(await closed).toBe(1008);
});

test("a reader that stops ends the server's watch", async () => {
  const ticks = rpc({ count: { mode: "stream", input: z.null(), output: z.number() } });
  let ended = 0;
  const countHere = operation({
    label: "count.here",
    input: z.null(),
    depends: { out: channel.required },
    run: async ({ out }) => {
      try {
        for (let n = 0; !out.closed.aborted; n++) {
          out.send(n);
          await tick(5);
        }
      } finally {
        ended++;
      }
    },
  });
  const { url } = await serverOf([ticks as never], [ticks({ implement: { count: countHere } })]);
  const client = await createScope({ capsules: [ws.client({ url }), ticks({ remote: ws.client })] })
    .ready;
  closers.push(() => client.close());

  const seen: number[] = [];
  for await (const n of await client.run(ticks.count, { input: null })) {
    seen.push(n as number);
    if (seen.length === 3) break;
  }
  await tick(50);
  expect(seen).toEqual([0, 1, 2]);
  expect(ended).toBe(1);
});

test("reset drops the socket: the next call opens a new one, and the old close fails nothing new", async () => {
  const transport = wsServer.server({ path: "/rpc", services: [api as never] });
  const scope = await createScope({
    capsules: [api({ implement: { greet: greetHere } }), transport],
  }).ready;
  closers.push(() => scope.close());

  const door = scope.resolve(transport);
  let upgrades = 0;
  const bun = Bun.serve({
    port: 0,
    idleTimeout: 0,
    websocket: door.websocket as never,
    fetch: (r, b) => {
      const reply = door.upgrade(r, scope, b as never);
      if (reply === null) upgrades += 1;
      return reply === null ? undefined : (reply ?? new Response(null, { status: 404 }));
    },
  });
  closers.push(() => bun.stop(true));

  const client = await createScope({
    capsules: [ws.client({ url: `ws://localhost:${bun.port}/rpc` }), api({ remote: ws.client })],
  }).ready;
  closers.push(() => client.close());

  expect(await client.run(api.greet, { input: { name: "a" } })).toEqual({ text: "Hello, a." });
  expect(upgrades).toBe(1);

  // A sign-in changed the cookie: the app resets, and the next call goes on a new socket at once,
  // before the old socket's close event comes.
  await client.run(ws.client.reset);
  expect(await client.run(api.greet, { input: { name: "b" } })).toEqual({ text: "Hello, b." });
  await tick();
  expect(await client.run(api.greet, { input: { name: "c" } })).toEqual({ text: "Hello, c." });
  expect(upgrades).toBe(2);
});
