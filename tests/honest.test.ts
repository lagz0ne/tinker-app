import { afterEach, expect, test } from "bun:test";

import { createScope, data, operation } from "@tinker/core";

import { memory } from "~/components/memory";
import { callInput, watchInput } from "~/components/protocol";
import type { Answer, Reply, Stream } from "~/components/protocol";
import { remoteData } from "~/components/remote-data";

import { wsClient } from "./support/ws";

// "If the server fails, we need to know": no failure ends as silence on the client.

const closers: Array<() => unknown> = [];

afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

/** A service with a bug: its answer and its stream throw (rpc and remoteData never do). */
const answer = operation({
  label: "boom.answer",
  input: callInput,
  run: async (): Promise<Reply | null> => {
    throw new Error("bug in answer");
  },
});

const stream = operation({
  label: "boom.stream",
  input: watchInput,
  run: async (): Promise<boolean> => {
    throw new Error("bug in stream");
  },
});

const boom = {
  label: "boom",
  addresses: ["boom"],
  answer: answer as Answer,
  stream: stream as Stream,
};

async function server(lines: string[] = []) {
  const todos = data({ initial: ["a"] });
  const board = remoteData({ todos });
  const s = createScope({
    observe: { log: (l) => void lines.push(l.message) },
    capsules: [board({ serve: true }), memory.server({ services: [board, boom] })],
  });
  await s.ready;
  closers.push(() => s.close());

  return { s, board };
}

async function client(peer: Awaited<ReturnType<typeof server>>["s"]) {
  const c = createScope({ capsules: [memory.client({ peer })] });
  await c.ready;
  closers.push(() => c.close());
  return c;
}

const pushes = async (c: Awaited<ReturnType<typeof client>>, address: string) => {
  const got: Reply[] = [];
  const stop = new AbortController();
  void Promise.resolve(
    c.run(memory.client.watch, {
      input: { address, value: null, meta: {}, push: (r) => void got.push(r) },
      signal: stop.signal,
    }),
  ).catch(() => undefined);
  await tick();
  stop.abort();

  return got;
};

test("a service that throws on a call: the client gets failed, the cause is in the server log only", async () => {
  const lines: string[] = [];
  const { s } = await server(lines);
  const c = await client(s);
  expect(
    await c.run(memory.client.call, { input: { address: "boom", value: null, meta: {} } }),
  ).toEqual({ ok: false, kind: "failed", payload: {} });
  expect(lines).toContain("protocol service failed");
});

test("a service that throws on a stream pushes failed, not a quiet end", async () => {
  const { s } = await server();
  expect(await pushes(await client(s), "boom")).toEqual([
    { ok: false, kind: "failed", payload: {} },
  ]);
});

test("an address no one has pushes link, as a 404 on a call", async () => {
  const { s } = await server();
  expect(await pushes(await client(s), "nope")).toEqual([{ ok: false, kind: "link", payload: {} }]);
});

test("a socket that cannot open makes the key's fault link, as data", async () => {
  const board = remoteData({ todos: data({ initial: [] as string[] }) });
  // The socket route is down: every upgrade answers 503.
  const bun = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 503 }) });
  closers.push(() => bun.stop(true));
  const c = createScope({
    capsules: [
      wsClient.client({ url: `ws://localhost:${bun.port}/api` }),
      board({ read: wsClient.client }),
    ],
  });
  closers.push(() => c.close());
  await c.ready;
  await tick(30);

  expect(c.resolve(board.faults).get().todos?.message).toContain("todos: link");
});
