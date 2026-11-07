import { afterEach, expect, test } from "bun:test";

import { createScope, data, operation } from "@tinker/core";
import type { Observe, Scope } from "@tinker/core";
import { z } from "zod";

import { memory } from "~/components/memory";
import { remoteData } from "~/components/remote-data";
import { rpc } from "~/components/rpc";

// O5: the server transport routes by a table built at start (gRPC addService, an HTTP router).

const closers: Array<() => unknown> = [];

afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

const startError = async (capsules: NonNullable<Parameters<typeof createScope>[0]>["capsules"]) => {
  const scope = createScope({ capsules });
  const error = await scope.ready.then(
    () => null,
    (e: unknown) => e,
  );
  await scope.close().catch(() => undefined);
  return { kind: Object(error).kind, payload: Object(error).payload };
};

/** A watch's first push, then the watch ends: a remoteData key is an rpc stream key. */
const first = async (scope: Scope.Handle, address: string) => {
  const stop = new AbortController();
  const got = Promise.withResolvers<string>();
  const watch = scope.run(memory.server.serveStream, {
    input: { address, text: "null", meta: {}, push: (t) => got.resolve(t), left: stop.signal },
  });

  const text = await got.promise;
  stop.abort();
  await watch;
  return JSON.parse(text);
};

test("two services with one address: the first wins and start warns, as Hono does", async () => {
  const board = remoteData({ "todo.add": data({ initial: 0 }) });
  const api = rpc({ "todo.add": { input: z.null(), output: z.null() } });
  const add = operation({ label: "add", input: z.null(), run: async () => null });
  const lines: string[] = [];
  const scope = createScope({
    observe: { log: (l) => void lines.push(`${l.message} ${JSON.stringify(l.attributes)}`) },
    capsules: [
      board({ serve: true }),
      api({ implement: { "todo.add": add } }),
      memory.server({ services: [board, api] }),
    ],
  });
  closers.push(() => scope.close());
  await scope.ready;

  const warned = lines.find((l) => l.startsWith("protocol duplicate address"));
  expect(warned).toContain('"winner":"remoteData"');
  expect(warned).toContain('"shadowed":"rpc"');
  // The board's key is a stream key: a call finds no reply key there (404), a watch gets the value.
  const reply = await scope.run(memory.server.serve, {
    input: { address: "todo.add", text: "null", meta: {} },
  });
  expect(reply).toBeNull();
  expect(await first(scope, "todo.add")).toEqual({ ok: true, value: 0 }); // the board answered
});

test("strict: two services with one address fail start, naming the address and both", async () => {
  const board = remoteData({ "todo.add": data({ initial: 0 }) });
  const api = rpc({ "todo.add": { input: z.null(), output: z.null() } });
  const add = operation({ label: "add", input: z.null(), run: async () => null });
  expect(
    await startError([
      board({ serve: true }),
      api({ implement: { "todo.add": add } }),
      memory.server({ services: [board, api], strict: true }),
    ]),
  ).toEqual({
    kind: "DuplicateAddress",
    payload: { address: "todo.add", services: ["remoteData", "rpc"] },
  });
});

test("no service has the address: the server answers null (404); the client gets link", async () => {
  const board = remoteData({ todos: data({ initial: [] as string[] }) });
  const server = createScope({
    capsules: [board({ serve: true }), memory.server({ services: [board] })],
  });
  await server.ready;
  closers.push(() => server.close());

  expect(
    await server.run(memory.server.serve, { input: { address: "nope", text: "null", meta: {} } }),
  ).toBeNull();
  const client = createScope({ capsules: [memory.client({ peer: server })] });
  await client.ready;
  closers.push(() => client.close());
  expect(
    await client.run(memory.client.call, { input: { address: "nope", value: null, meta: {} } }),
  ).toEqual({ ok: false, kind: "link", payload: {} });
});

test("30 definitions × 3 keys and one rpc with 30 keys: each call reaches its own service, and only it", async () => {
  const boards = Array.from({ length: 30 }, (_, b) =>
    remoteData(
      Object.fromEntries(
        [0, 1, 2].map((k) => [`b${b}.k${k}`, data({ initial: `board ${b} key ${k}` })]),
      ),
    ),
  );

  const keys = Array.from({ length: 30 }, (_, i) => `op${i}`);
  const api = rpc(
    Object.fromEntries(keys.map((k) => [k, { input: z.null(), output: z.string() }])),
  );
  const implement = Object.fromEntries(
    keys.map((k) => [
      k,
      operation({ label: `${k}.do`, input: z.null(), run: async () => `answered ${k}` }),
    ]),
  );
  const spans: Observe.Span[] = [];
  const server = createScope({
    observe: { export: (x) => void spans.push(x) },
    capsules: [
      ...boards.map((b) => b({ serve: true })),
      api({ implement: implement as never }),
      memory.server({ services: [...boards, api] }),
    ],
  });
  await server.ready;
  closers.push(() => server.close());
  const ask = async (address: string) =>
    JSON.parse(
      (await server.run(memory.server.serve, { input: { address, text: "null", meta: {} } }))!,
    );
  for (let b = 0; b < 30; b++) {
    for (let k = 0; k < 3; k++) {
      expect(await first(server, `b${b}.k${k}`)).toEqual({
        ok: true,
        value: `board ${b} key ${k}`,
      });
    }
  }
  for (const k of keys) expect(await ask(k)).toEqual({ ok: true, value: `answered ${k}` });
  const count = (name: string) => spans.filter((x) => x.name === name).length;
  // Each ask ran exactly one service: 90 board watches, 30 rpc answers. Asking in turn would
  // have run up to 31 services per ask.
  expect([count("remoteData.stream"), count("rpc.answer")]).toEqual([90, 30]);
});

test("one shared stream carries keys of two definitions; each is routed to its own", async () => {
  const todos = data({ initial: [] as string[] });
  const theme = data({ initial: "light" });
  const board = remoteData({ todos });
  const prefs = remoteData({ theme });
  const set = operation({
    label: "set",
    input: z.null(),
    depends: { t: todos.controller, p: theme.controller },
    run: async ({ t, p }) => (t.set(["a"]), p.set("dark")),
  });
  const server = createScope({
    capsules: [
      board({ serve: true }),
      prefs({ serve: true }),
      memory.server({ services: [board, prefs] }),
    ],
  });
  await server.ready;
  closers.push(() => server.close());
  const client = createScope({
    capsules: [
      memory.client({ peer: server }),
      board({ read: memory.client }),
      prefs({ read: memory.client }),
    ],
  });
  await client.ready;
  closers.push(() => client.close());
  await new Promise((r) => setTimeout(r, 30));
  await server.run(set, { input: null });
  await new Promise((r) => setTimeout(r, 30));

  expect([client.resolve(board.todos).get(), client.resolve(prefs.theme).get()]).toEqual([
    ["a"],
    "dark",
  ]);
});
