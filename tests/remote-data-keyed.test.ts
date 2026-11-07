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

/** A watch the test stops ends in AbortError: that is the end, not a fault. Anything else throws. */
const stopped = (e: unknown) => {
  if (Object(e).name !== "AbortError") throw e;
};

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

  // One watch for p1, not two: one client, one entry per project. Its first push is the value
  // now, so the server fills once.
  expect(app.fills.filter((p) => p === "p1").length).toBe(1);
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
  const watches: Promise<unknown>[] = [];
  closers.push(() => (stop.abort(), Promise.all(watches)));
  for (const key of ["p1", "p2"]) {
    const watch = tab.run(memory.client.watch, {
      input: {
        address: "tasks",
        value: { project: key },
        meta: {},
        push: (r) => got[key]!.push(r),
      },
      signal: stop.signal,
    });
    watches.push(watch.catch(stopped)); // a stopped watch ends in AbortError
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
    // A keyed session only watches: nothing reached the server.
    expect(app.fills.length).toBe(0);
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
    const watches: Promise<unknown>[] = [];
    closers.push(() => (stop.abort(), Promise.all(watches)));
    for (let i = 0; i < 6; i++) {
      got[i] = [];
      const watch = tab.run(memory.client.watch, {
        input: {
          address: "tasks",
          value: { project: `${long(600)}${i}` },
          meta: {},
          push: (r) => got[i]!.push(r),
        },
        signal: stop.signal,
      });
      watches.push(watch.catch(stopped));
    }
    await until(() => Object.values(got).every((list) => list.length > 0));

    for (let i = 0; i < 6; i++) expect(got[i]![0]).toMatchObject({ ok: true, value: [`v${i}`] });
  });
});

describe("the shared stream stays readable by the other side's version", () => {
  test("each frame entry names its address first: a client from before routes by address", async () => {
    const app = boot("memory");
    await app.ready;
    const pushed: string[] = [];
    const list = [
      ["tasks", JSON.stringify({ project: "p1" })],
      ["tasks", JSON.stringify({ project: "p2" })],
    ];
    const stop = new AbortController();
    const watch = app.server.run(memory.server.serveStream, {
      input: { address: "*", text: JSON.stringify(list), meta: {}, push: (t) => pushed.push(t) },
      signal: stop.signal,
    });
    closers.push(() => (stop.abort(), watch.catch(stopped)));
    await until(() => pushed.length > 0);

    const entries = pushed.flatMap((t) => JSON.parse(t) as [string, string, number][]);
    // The old client reads `[to, text]` of each entry: the address, then that member's reply.
    expect(entries.map(([to]) => to)).toEqual(["tasks", "tasks"]);
    const byPlace = Object.fromEntries(entries.map(([, t, at]) => [at, JSON.parse(t).value]));
    expect(byPlace).toEqual({ 0: ["p1 first"], 1: ["p2 first"] });
  });

  test("a server from before sends `[address, text]`: the client routes it by address", async () => {
    const notes = data({ initial: [] as string[], parse: z.array(z.string()) });
    const plain = remoteData({ notes });
    const read = JSON.stringify({ ok: true, value: ["from a read"] });
    const reply = JSON.stringify({ ok: true, value: ["from an old server"] });
    const enc = new TextEncoder();
    const old = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch: (r) => {
        const path = new URL(r.url).pathname;
        if (r.method === "POST") return new Response(read);
        if (!path.endsWith("/*")) return new Response(null, { status: 404 });

        // The old frame: `[address, text]`, no place.
        const frame = JSON.stringify([["notes", reply]]);
        const body = new ReadableStream({
          start: (out) => out.enqueue(enc.encode(`: open\n\ndata: ${JSON.stringify(frame)}\n\n`)),
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });
    closers.push(() => old.stop(true));

    const tab = createScope({
      capsules: [
        sseClient.client({ base: `http://localhost:${old.port}/api`, streams: "one" }),
        plain({ read: sseClient.client }),
      ],
    });
    closers.push(() => tab.close());
    await tab.ready;

    // The push came over the shared stream, in the old frame, and reached its member.
    await until(() => tab.resolve(plain.notes).get()[0] === "from an old server");
  });
});

test("a keyed write with no project bound fails before it runs: MissingTag", async () => {
  const app = boot("memory");
  await app.ready;
  const tab = app.client();
  await tab.ready;
  const s = tab.createSession({ tags: [board.project("p1")] });
  await until(() => read(s).length > 0);

  let ran = 0;
  const write = operation({
    label: "tasks.untagged",
    depends: { list: tasks.controller },
    run: ({ list }) => (ran++, list.set(["lost"])),
  });
  // No project: the write would go to no one, so it fails, as Core fails a missing tag.
  const failed = await Promise.resolve(app.server.run(write)).then(
    () => null,
    (e: unknown) => e,
  );
  expect(failed).toMatchObject({ kind: "MissingTag", payload: { label: "project" } });
  expect(ran).toBe(0);

  // Tagged, the same write runs and reaches p1.
  await app.server.run(write, { tags: [board.project("p1")] });
  await until(() => read(s)[0] === "lost");
  expect(ran).toBe(1);
});

test("a child session on the parent's project shares its watch: no new request", async () => {
  const app = boot("memory");
  await app.ready;
  const tab = app.client();
  await tab.ready;

  const s = tab.createSession({ tags: [board.project("p1")] });
  await until(() => read(s).length > 0);
  const fills = app.fills.length;

  // A short call session inside s joins p1 too: it shares the entry, so no new watch, no new fill.
  const seen = operation({
    label: "seen",
    depends: { list: board.tasks },
    run: ({ list }) => list.get(),
  });
  const ac = new AbortController();
  expect(await s.run(seen, { signal: ac.signal })).toEqual(["p1 first"]);
  await tick();
  expect(app.fills.length).toBe(fills);

  // And the parent still gets pushes after the child closed.
  await app.write("p1", "after the child");
  await until(() => read(s).length === 2);
});

for (const kind of ["memory", "sse"] as const) {
  test(`${kind}: a shared stream outlives its first member: the others read on, and it closes after the last`, async () => {
    const app = boot(kind);
    await app.ready;
    const tab = app.client({ streams: "one" });
    await tab.ready;

    const got: Record<string, unknown[]> = { p1: [], p2: [] };
    const stop = { p1: new AbortController(), p2: new AbortController() };
    const watches: Promise<unknown>[] = [];
    for (const key of ["p1", "p2"] as const) {
      const watch = tab.run((kind === "memory" ? memory.client : sseClient.client).watch, {
        input: {
          address: "tasks",
          value: { project: key },
          meta: {},
          push: (r) => got[key]!.push(r),
        },
        signal: stop[key].signal,
      });
      watches.push(watch.catch(stopped));
    }
    closers.push(() => (stop.p1.abort(), stop.p2.abort(), Promise.all(watches)));
    await until(() => got.p1!.length > 0 && got.p2!.length > 0);

    stop.p1.abort(); // the first member leaves first
    await tick();
    await app.write("p2", "after p1 left");
    await until(() => got.p2!.length === 2);
    expect(got.p2![1]).toMatchObject({ ok: true, value: ["p2 first", "after p1 left"] });

    stop.p2.abort(); // the last member leaves: the stream closes, and the server forgets p2
    await tick();
    await app.write("p2", "while no one watched");
    const again = tab.createSession({ tags: [board.project("p2")] });
    await until(() => read(again).length === 3);
    expect(app.fills.filter((p) => p === "p2").length).toBe(2);
  });
}
