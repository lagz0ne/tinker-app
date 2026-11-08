import { afterEach, describe, expect, test } from "bun:test";

import { createScope, data, namespace, operation, tag } from "@tinker/core";
import type { Scope, Tag } from "@tinker/core";
import { z } from "zod";

import { memory } from "~/components/memory";
import { hook } from "~/components/protocol";
import { remoteData } from "~/components/remote-data";

import { listen, wsClient, wsServer } from "./support/ws";

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
async function boot(kind: "memory" | "ws", options: { refuse?: string } = {}) {
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
    input: hook.start,
    run: async (_, { input }) =>
      Object(input.input)?.project === options.refuse
        ? input.refuse({ project: options.refuse })
        : undefined,
  });

  const transport = wsServer.server({ path: "/api", services: [board] });
  const server = await createScope({
    capsules: [
      board({ serve: true, fill: { tasks: tasksNow }, onStart: [guard] }),
      transport,
      memory.server({ services: [board] }),
    ],
  }).ready;
  closers.push(() => server.close());
  let base = "";
  if (kind === "ws") {
    const { bun, url } = listen(server, [transport]);
    closers.push(() => bun.stop(true));
    base = `${url}/api`;
  }

  const write = (key: string, title: string) =>
    server.run(add, { input: { project: key, title }, tags: [board.project(key)] });

  const client = async (extra: { tags?: Tag.Bindings } = {}) => {
    const t = kind === "memory" ? memory.client : wsClient.client;
    const scope = await createScope({
      tags: extra.tags,
      capsules: [
        kind === "memory" ? memory.client({ peer: server }) : wsClient.client({ url: base }),
        board({ read: t }),
      ],
    }).ready;
    closers.push(() => scope.close());
    return scope;
  };
  return {
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

for (const kind of ["memory", "ws"] as const) {
  describe(kind, () => {
    test("two sessions, two projects: each reads its own list; the root names none", async () => {
      const app = await boot(kind);

      const tab = await app.client();

      const p1 = tab.createSession({ tags: [board.project("p1")] });
      const p2 = tab.createSession({ tags: [board.project("p2")] });
      await until(() => read(p1).length > 0 && read(p2).length > 0);

      expect(read(p1)).toEqual(["p1 first"]);
      expect(read(p2)).toEqual(["p2 first"]);
      expect(tab.resolve(board.tasks).get()).toEqual([]); // the root names no project
    });

    test("a write for p1 reaches only p1's sessions, across two clients", async () => {
      const app = await boot(kind);

      const [a, b] = await Promise.all([app.client(), app.client()]);

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

    test("one client carries two projects of one key, and each gets its own", async () => {
      const app = await boot(kind);

      const tab = await app.client();

      const p1 = tab.createSession({ tags: [board.project("p1")] });
      const p2 = tab.createSession({ tags: [board.project("p2")] });
      await until(() => read(p1).length > 0 && read(p2).length > 0);

      await tick();

      await app.write("p2", "p2 second");

      await until(() => read(p2).length === 2);

      expect(read(p1)).toEqual(["p1 first"]);
    });

    test("bound at the root: the root reads that project, as an unkeyed board does", async () => {
      const app = await boot(kind);

      const tab = await app.client({ tags: [board.project("p2")] });

      await until(() => tab.resolve(board.tasks).get().length > 0);

      expect(tab.resolve(board.tasks).get()).toEqual(["p2 first"]);
    });

    test("a refused project shows in that session's faults; the other reads on", async () => {
      const app = await boot(kind, { refuse: "p2" });

      const tab = await app.client();

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
  const app = await boot("memory");

  const tab = await app.client();

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
  const app = await boot("memory");

  const reply = await app.server.run(board.answer, {
    input: { address: "tasks", value: { project: 7 }, meta: {} },
  });
  expect(reply).toMatchObject({ ok: false, kind: "invalid" });
});

test("a session made with a namespace whose tags bind the project reads that project", async () => {
  const app = await boot("memory");

  const tab = await app.client();

  const space = namespace({ tags: [board.project("p2")] });
  const s = tab.createSession({ ns: space });
  await until(() => read(s).length > 0);

  expect(read(s)).toEqual(["p2 first"]);
});

test("the definition refuses a config key that is a cell or reserved", () => {
  const t = tag<string>({ label: "t" });
  expect(() => remoteData({ tasks }, { config: { tasks: t } })).toThrow(/config tasks/);
  expect(() => remoteData({ tasks }, { config: { faults: t } })).toThrow(/config faults/);
});

test("a keyed write with no project bound fails before it runs: MissingTag", async () => {
  const app = await boot("memory");
  const tab = await app.client();
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
  const app = await boot("memory");
  const tab = await app.client();

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
