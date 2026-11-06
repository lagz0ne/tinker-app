import { afterEach, expect, test } from "bun:test";

import { createScope, data, operation } from "@tinker/core";
import type { Observe } from "@tinker/core";
import { z } from "zod";

import { memory } from "~/components/memory";
import { step } from "~/components/protocol";
import type { Middleware } from "~/components/protocol";
import { remoteData } from "~/components/remote-data";

// remoteData over the app's own cells: plain data, no label; the key is the address.

const closers: Array<() => unknown> = [];

afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

/** A server serving `def`, and a client reading it, over memory. */
async function pair(
  def: ReturnType<typeof remoteData<{}>>,
  extra: { use?: Middleware[]; observe?: Observe.Config } = {},
) {
  const server = createScope({
    observe: extra.observe,
    capsules: [def({ serve: true, use: extra.use }), memory.server({ services: [def] })],
  });
  await server.ready;
  closers.push(() => server.close());
  const client = createScope({
    capsules: [memory.client({ peer: server }), def({ read: memory.client })],
  });
  closers.push(() => client.close());

  return { server, client };
}

test("the same plain cell on both sides: no label, a Date crosses through the codec only", async () => {
  const todos = data({ initial: ["a"], parse: z.array(z.string()) });
  const seen = data({ initial: new Date(0) }); // no parse, no label: the codec decides what crosses
  const board = remoteData({ todos, seen });
  const add = operation({
    label: "add",
    input: z.string(),
    depends: { list: todos.controller },
    run: async ({ list }, { input }) => list.set([...list.get(), input]),
  });
  const { server, client } = await pair(board);
  await client.ready;

  expect(client.resolve(board.todos).get()).toEqual(["a"]);
  expect(String(client.resolve(board.seen).get())).toBe("1970-01-01T00:00:00.000Z"); // JSON gives a string: the type says Date. keepDates keeps it.
  expect(client.resolve(board.seen).get()).not.toBeInstanceOf(Date);
  await server.run(add, { input: "b" });
  await tick();
  expect(client.resolve(board.todos).get()).toEqual(["a", "b"]);
  expect(client.resolve(todos)).toEqual(["a"]); // the passed cell is a shape: the client fills its own
  expect(server.resolve(board.todos).get()).toEqual(["a", "b"]); // the server copies each write
});

test("two definitions in one app: each key is its own address", async () => {
  const todos = data({ initial: ["a"] });
  const theme = data({ initial: "light" });
  const board = remoteData({ todos });
  const prefs = remoteData({ theme });
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

  expect([client.resolve(board.todos).get(), client.resolve(prefs.theme).get()]).toEqual([
    ["a"],
    "light",
  ]);
});

test("a feature reads the export: a reader with no controller, so it cannot write", async () => {
  const todos = data({ initial: ["a"] });
  const board = remoteData({ todos });
  const add = operation({
    label: "add",
    input: z.string(),
    depends: { list: (board.todos as any).controller as typeof todos.controller },
    run: async ({ list }, { input }) => list.set([...list.get(), input]),
  });
  const { client } = await pair(board);
  await client.ready;
  const out = await client.settle(add, { input: "local" });

  expect(Object(out).error).toMatchObject({ kind: "InvalidDependency" });
  expect(client.resolve(board.todos).get()).toEqual(["a"]);
  expect(() => remoteData({ answer: data({ initial: 1 }) })).toThrow("reserved");
});

test("parse checks both sides: the server cannot write a bad value; a client read of one throws invalid", async () => {
  const count = data({ initial: 1, parse: z.number() });
  const set = operation({
    label: "set",
    input: z.unknown(),
    depends: { c: count.controller },
    run: async ({ c }, { input }) => c.set(input as number),
  });
  const { server, client } = await pair(remoteData({ count }));
  await client.ready;
  expect(Object(await server.settle(set, { input: "two" })).error).toMatchObject({
    kind: "DataValidationFailed",
  });

  // An older server whose cell has no parse, at the same address: the client does not hide the
  // bad value behind the last good one. Reading the key throws `invalid` (side "client") until
  // a good value arrives (F5).
  const loose = data({ initial: 1 as unknown });
  const put = operation({
    label: "put",
    input: z.unknown(),
    depends: { c: loose.controller },
    run: async ({ c }, { input }) => c.set(input),
  });
  const lines: string[] = [];
  const older = remoteData({ count: loose });
  const s2 = createScope({
    capsules: [older({ serve: true }), memory.server({ services: [older] })],
  });
  await s2.ready;
  closers.push(() => s2.close());
  const strict = remoteData({ count }); // the same shape again: a new definition, its own cell
  const c2 = createScope({
    observe: { log: (l) => void lines.push(l.message) },
    capsules: [memory.client({ peer: s2 }), strict({ read: memory.client })],
  });
  await c2.ready;
  closers.push(() => c2.close());
  await s2.run(put, { input: 2 });
  await tick();
  expect(c2.resolve(strict.count).get()).toBe(2);
  await s2.run(put, { input: "two" });
  await tick();
  expect(c2.resolve(strict.count).get()).toBe(2); // the last good value stays
  const caught = c2.resolve(strict.faults).get().count;
  expect(strict.fault.is(caught)).toBe(true);
  expect(caught).toMatchObject({ fault: "invalid", payload: { side: "client" }, address: "count" });
  expect(lines).toContain("remoteData value refused");
  await s2.run(put, { input: 3 });
  await tick();
  expect(c2.resolve(strict.count).get()).toBe(3);
  expect(c2.resolve(strict.faults).get().count).toBeUndefined(); // a good value clears it
});

test("a bad value on the first read: start still ends; faults shows invalid, with its trace", async () => {
  const loose = data({ initial: "x" as unknown });
  const put = operation({
    label: "put",
    input: z.unknown(),
    depends: { c: loose.controller },
    run: async ({ c }, { input }) => c.set(input),
  });
  const older = remoteData({ count: loose });
  const s2 = createScope({
    capsules: [older({ serve: true }), memory.server({ services: [older] })],
  });
  await s2.ready;
  closers.push(() => s2.close());
  const strict = remoteData({ count: data({ initial: 0, parse: z.number() }) });
  const c2 = createScope({
    observe: { export: () => undefined },
    capsules: [memory.client({ peer: s2 }), strict({ read: memory.client })],
  });
  await c2.ready;
  closers.push(() => c2.close());

  expect(c2.resolve(strict.faults).get().count?.message).toMatch(
    /count: invalid \(trace [0-9a-f]{32}\)/,
  );
  await s2.run(put, { input: 5 });
  await tick();
  expect(c2.resolve(strict.count).get()).toBe(5);
});

test("faults, not errors: a refusal is a value; a throw is `failed`, its text in the server log only", async () => {
  const todos = data({ initial: [] as string[] });
  const board = remoteData({ todos });
  const refuse = operation({
    label: "refuse",
    input: step,
    run: async (_, { input }) => input.refuse({ signIn: true }),
  });
  const crash = operation({
    label: "crash",
    input: step,
    run: (): never => {
      throw new Error("db password is hunter2");
    },
  });
  const lines: string[] = [];
  const failure = async (use: Middleware[]) => {
    const { client } = await pair(board, {
      use,
      observe: { log: (l) => void lines.push(`${l.message} ${JSON.stringify(l.attributes)}`) },
    });
    await client.ready; // a fault never fails start
    const e = client.resolve(board.faults).get().todos;
    return e && { fault: e.fault, payload: e.payload };
  };

  expect(await failure([refuse])).toEqual({ fault: "refused", payload: { signIn: true } });
  const crashed = await failure([crash]);
  expect(crashed).toEqual({ fault: "failed", payload: {} });
  expect(JSON.stringify(crashed)).not.toContain("hunter2");
  expect(lines.some((l) => l.includes("remoteData failed") && l.includes("hunter2"))).toBe(true);
});

test("a fault is data beside the value, and clears when a good value arrives", async () => {
  const todos = data({ initial: ["a"] });
  const board = remoteData({ todos });
  let open = false;
  const gate = operation({
    label: "gate",
    input: step,
    run: async (_, { input }) => (open ? input.next() : input.refuse({ signIn: true })),
  });
  const { client } = await pair(board, { use: [gate] });
  await client.ready;

  expect(client.resolve(board.faults).get().todos?.fault).toBe("refused");
  expect(client.resolve(board.todos).get()).toEqual(["a"]); // the read itself never throws
  open = true; // the user signs in
  const end = Date.now() + 3000;
  while (Date.now() < end && client.resolve(board.faults).get().todos) await tick(20);
  expect(client.resolve(board.faults).get()).toEqual({});
  expect(client.resolve(board.todos).get()).toEqual(["a"]);
});

test("F45 B: a session read and an op's depends see the fault, with no resolve hook", async () => {
  const todos = data({ initial: ["a"] });
  const board = remoteData({ todos });
  const refuse = operation({
    label: "refuse",
    input: step,
    run: async (_, { input }) => input.refuse({ signIn: true }),
  });
  const { client } = await pair(board, { use: [refuse] });
  await client.ready;
  const read = operation({
    label: "read",
    depends: { list: board.todos, faults: board.faults },
    run: async ({ list, faults }) => ({ list: list.get(), why: faults.get().todos?.fault }),
  });

  expect(await client.settle(read)).toMatchObject({
    status: "success",
    value: { list: ["a"], why: "refused" },
  });
  const session = client.createSession({});
  expect(session.resolve(board.faults).get().todos?.fault).toBe("refused");
  const inCall = await client.run(read, { signal: new AbortController().signal }); // a child session
  expect(inCall.why).toBe("refused");
  await session.close();
});

test("a remoteData fault carries the trace id of the read or push that brought it", async () => {
  const todos = data({ initial: ["a"] });
  const board = remoteData({ todos });
  const refuse = operation({
    label: "refuse",
    input: step,
    run: async (_, { input }) => input.refuse({ signIn: true }),
  });
  const server = createScope({
    capsules: [board({ serve: true, use: [refuse] }), memory.server({ services: [board] })],
  });
  await server.ready;
  closers.push(() => server.close());
  const spans: Observe.Span[] = [];
  const client = createScope({
    observe: { export: (x) => void spans.push(x) },
    capsules: [memory.client({ peer: server }), board({ read: memory.client })],
  });
  await client.ready;
  closers.push(() => client.close());
  const error = client.resolve(board.faults).get().todos;
  if (!board.fault.is(error)) throw new Error("expected a board fault");

  expect(error.traceId).toBeString();
  // The last fault wins: the first read's, or a later push's (the watch keeps trying).
  const from = spans.filter((x) => x.traceId === error.traceId).map((x) => x.name);
  expect(from.some((n) => n === "remoteData.get" || n === "remoteData.receive")).toBe(true);
});
