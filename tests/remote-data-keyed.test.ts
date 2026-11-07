import { afterEach, describe, expect, test } from "bun:test";

import { createScope, data, namespace, operation, tag } from "@tinker/core";
import type { Scope, Tag } from "@tinker/core";
import { z } from "zod";

import { memory } from "~/components/memory";
import { step, watchTextMax } from "~/components/protocol";
import { remoteData } from "~/components/remote-data";

import { sseClient, sseServer } from "./support/sse";

// F12: a remoteData definition declares a config, as a capsule does. The instance turns each key
// into a tag (`project`); userland binds it where it fits: the root, a session, a namespace.

const closers: Array<() => unknown> = [];

afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await tick(10);
  }
};

/** The app's shared definition: one list of tasks per project. */
const tasks = data({ initial: [] as string[], parse: z.array(z.string()) });

/** The definition takes the app's tag as config, as a capsule does; all use goes through `board`. */
const board = remoteData(
  { tasks },
  { config: { project: tag<string>({ label: "project", parse: z.string() }) } },
);

/** The server's store, by project (a database in the real app). */
function boot(kind: "memory" | "sse", options: { refuse?: string } = {}) {
  const db = new Map<string, string[]>([
    ["p1", ["p1 first"]],
    ["p2", ["p2 first"]],
  ]);
  const fills: string[] = [];

  // The fill: the first value of one project, read in a call tagged with it.
  const tasksNow = operation({
    label: "tasks.now",
    depends: { key: board.project },
    run: ({ key }) => (fills.push(key), db.get(key) ?? []),
  });
  // A writer: it changes the store, then sets the cell in a call tagged with the project.
  const add = operation({
    label: "tasks.add",
    input: z.object({ project: z.string(), title: z.string() }),
    depends: { list: tasks.controller },
    run: ({ list }, { input }) => {
      db.set(input.project, [...(db.get(input.project) ?? []), input.title]);
      list.set(db.get(input.project)!);
    },
  });
  // A guard: it sees the parameter, as it sees the key.
  const guard = operation({
    label: "guard",
    input: step,
    run: async (_, { input }) =>
      Object(input.input).param?.project === options.refuse
        ? input.refuse({ project: options.refuse })
        : input.next(),
  });

  const transport = sseServer.server({ base: "/api", services: [board] });
  const server = createScope({
    capsules: [
      board({ serve: true, fill: { tasks: tasksNow }, use: [guard] }),
      transport,
      memory.server({ services: [board] }),
    ],
  });
  let base = "";
  const ready = server.ready.then(() => {
    if (kind === "sse") {
      const handle = server.resolve(transport);
      const bun = Bun.serve({
        port: 0,
        idleTimeout: 0,
        fetch: async (r) => (await handle(r, server)) ?? new Response(null, { status: 404 }),
      });
      closers.push(() => bun.stop(true));
      base = `http://localhost:${bun.port}/api`;
    }
  });
  closers.push(() => server.close());

  const write = (key: string, title: string) =>
    server.run(add, { input: { project: key, title }, tags: [board.project(key)] });

  const client = (extra: { tags?: Tag.Bindings; streams?: "each" | "one" } = {}) => {
    const t = kind === "memory" ? memory.client : sseClient.client;
    const scope = createScope({
      tags: extra.tags,
      capsules: [
        kind === "memory"
          ? memory.client({ peer: server, streams: extra.streams })
          : sseClient.client({ base, streams: extra.streams }),
        board({ read: t }),
      ],
    });
    closers.push(() => scope.close());
    return scope;
  };
  return {
    ready,
    server,
    write,
    client,
    db,
    fills,
    get base() {
      return base;
    },
  };
}

const read = (s: Scope.Handle) => s.resolve(board.tasks).get();
const faultOf = (s: Scope.Handle) => s.resolve(board.faults).get().tasks;

for (const kind of ["memory", "sse"] as const) {
  describe(kind, () => {
    test("two sessions, two projects: each reads its own list; the root names none", async () => {
      const app = boot(kind);
      await app.ready;

      const tab = app.client();
      await tab.ready;

      const p1 = tab.createSession({ tags: [board.project("p1")] });
      const p2 = tab.createSession({ tags: [board.project("p2")] });
      await until(() => read(p1).length > 0 && read(p2).length > 0);

      expect(read(p1)).toEqual(["p1 first"]);
      expect(read(p2)).toEqual(["p2 first"]);
      expect(tab.resolve(board.tasks).get()).toEqual([]); // the root names no project
    });

    test("a write for p1 reaches only p1's sessions, across two clients", async () => {
      const app = boot(kind);
      await app.ready;

      const a = app.client();
      const b = app.client();
      await Promise.all([a.ready, b.ready]);

      const a1 = a.createSession({ tags: [board.project("p1")] });
      const b1 = b.createSession({ tags: [board.project("p1")] });
      const b2 = b.createSession({ tags: [board.project("p2")] });
      await until(() => read(a1).length > 0 && read(b1).length > 0 && read(b2).length > 0);

      await tick(); // the watches are open

      await app.write("p1", "p1 second");

      await until(() => read(a1).length === 2 && read(b1).length === 2);

      expect(read(a1)).toEqual(["p1 first", "p1 second"]);
      expect(read(b1)).toEqual(["p1 first", "p1 second"]);
      await tick();

      expect(read(b2)).toEqual(["p2 first"]);
    });

    test("one shared stream carries two projects of one key, and each gets its own", async () => {
      const app = boot(kind);
      await app.ready;

      const tab = app.client({ streams: "one" });
      await tab.ready;

      const p1 = tab.createSession({ tags: [board.project("p1")] });
      const p2 = tab.createSession({ tags: [board.project("p2")] });
      await until(() => read(p1).length > 0 && read(p2).length > 0);

      await tick();

      await app.write("p2", "p2 second");

      await until(() => read(p2).length === 2);

      expect(read(p1)).toEqual(["p1 first"]);
    });

    test("bound at the root: the root reads that project, as an unkeyed board does", async () => {
      const app = boot(kind);
      await app.ready;

      const tab = app.client({ tags: [board.project("p2")] });
      await tab.ready;

      await until(() => tab.resolve(board.tasks).get().length > 0);

      expect(tab.resolve(board.tasks).get()).toEqual(["p2 first"]);
    });

    test("a refused project shows in that session's faults; the other reads on", async () => {
      const app = boot(kind, { refuse: "p2" });
      await app.ready;

      const tab = app.client();
      await tab.ready;

      const p1 = tab.createSession({ tags: [board.project("p1")] });
      const p2 = tab.createSession({ tags: [board.project("p2")] });
      await until(() => read(p1).length > 0 && faultOf(p2) !== undefined);

      expect(faultOf(p2)).toMatchObject({ fault: "refused", payload: { project: "p2" } });
      expect(read(p2)).toEqual([]);
      expect(faultOf(p1)).toBeUndefined();
    });
  });
}

test("the server fills a project once while it is watched, and forgets it when no one watches", async () => {
  const app = boot("memory");
  await app.ready;

  const tab = app.client();
  await tab.ready;

  const s1 = tab.createSession({ tags: [board.project("p1")] });
  const s2 = tab.createSession({ tags: [board.project("p1")] }); // the same project: shares the watch
  await until(() => read(s1).length > 0 && read(s2).length > 0);

  await tick();

  // One read and one watch for p1, not two: one client, one entry per project.
  expect(app.fills.filter((p) => p === "p1").length).toBe(2); // the read, then the watch's value now
  await s1.close();
  await s2.close();
  await tick();

  await app.write("p1", "while no one watched");

  const again = tab.createSession({ tags: [board.project("p1")] });
  await until(() => read(again).length === 2);

  expect(read(again)).toEqual(["p1 first", "while no one watched"]);
});

test("a parameter that does not fit the config is invalid on the server", async () => {
  const app = boot("memory");
  await app.ready;

  const reply = await app.server.run(board.answer, {
    input: { address: "tasks", value: { project: 7 }, meta: {} },
  });
  expect(reply).toMatchObject({ ok: false, kind: "invalid" });
});

test("a session made with a namespace whose tags bind the project reads that project", async () => {
  const app = boot("memory");
  await app.ready;

  const tab = app.client();
  await tab.ready;

  const space = namespace({ tags: [board.project("p2")] });
  const s = tab.createSession({ ns: space });
  await until(() => read(s).length > 0);

  expect(read(s)).toEqual(["p2 first"]);
});

test("the shared stream routes by place, not address: two values of one address in one tick", async () => {
  const app = boot("memory");
  await app.ready;
  const tab = app.client({ streams: "one" });
  await tab.ready;

  const got: Record<string, unknown[]> = { p1: [], p2: [] };
  const stop = new AbortController();
  closers.unshift(() => stop.abort());
  for (const key of ["p1", "p2"]) {
    void tab.run(memory.client.watch, {
      input: {
        address: "tasks",
        value: { project: key },
        meta: {},
        push: (r) => got[key]!.push(r),
      },
      signal: stop.signal,
    });
  }
  await until(() => got.p1!.length > 0 && got.p2!.length > 0);

  expect(got.p1![0]).toMatchObject({ ok: true, value: ["p1 first"] });
  expect(got.p2![0]).toMatchObject({ ok: true, value: ["p2 first"] });
});

test("the definition refuses a config key that is a cell or reserved", () => {
  const t = tag<string>({ label: "t" });
  expect(() => remoteData({ tasks }, { config: { tasks: t } })).toThrow(/config tasks/);
  expect(() => remoteData({ tasks }, { config: { faults: t } })).toThrow(/config faults/);
});

describe("the protocol holds the watch's length", () => {
  const long = (n: number) => "x".repeat(n);

  test("a parameter too long for a watch is the client's encode fault: the watch is not sent", async () => {
    const app = boot("memory");
    await app.ready;
    const tab = app.client();
    await tab.ready;

    const s = tab.createSession({ tags: [board.project(long(watchTextMax))] });
    await until(() => faultOf(s) !== undefined);

    expect(faultOf(s)).toMatchObject({ fault: "encode", payload: { side: "client" } });
    // The read is a POST, under the body's own cap: it went. The watch (a GET) did not.
    expect(app.fills.length).toBe(1);
  });

  test("the server reads no watch text past the line: invalid, on memory and on SSE", async () => {
    const app = boot("sse");
    await app.ready;
    const text = JSON.stringify({ project: long(watchTextMax) });
    const pushed: string[] = [];

    await app.server.run(memory.server.serveStream, {
      input: { address: "tasks", text, meta: {}, push: (t) => pushed.push(t) },
    });
    expect(JSON.parse(pushed[0]!)).toMatchObject({ ok: false, kind: "invalid" });

    const asked = await fetch(`${app.base}/tasks?text=${encodeURIComponent(text)}`);
    const said = await asked.text();
    expect(said).toContain('\\"kind\\":\\"invalid\\"');
  });

  test("a shared stream splits so no part passes the line, and every member gets its value", async () => {
    const app = boot("memory");
    await app.ready;
    for (let i = 0; i < 6; i++) app.db.set(`${long(600)}${i}`, [`v${i}`]);
    const tab = app.client({ streams: "one" });
    await tab.ready;

    const got: Record<number, unknown[]> = {};
    const stop = new AbortController();
    closers.unshift(() => stop.abort());
    for (let i = 0; i < 6; i++) {
      got[i] = [];
      void tab.run(memory.client.watch, {
        input: {
          address: "tasks",
          value: { project: `${long(600)}${i}` },
          meta: {},
          push: (r) => got[i]!.push(r),
        },
        signal: stop.signal,
      });
    }
    await until(() => Object.values(got).every((list) => list.length > 0));

    for (let i = 0; i < 6; i++) expect(got[i]![0]).toMatchObject({ ok: true, value: [`v${i}`] });
  });
});
