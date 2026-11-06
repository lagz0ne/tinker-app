import { afterEach, describe, expect, test } from "bun:test";

import { createScope } from "@tinker/core";
import { z } from "zod";

import { memory } from "~/components/memory";
import { routes } from "~/components/requests/index.server";
import { rpc } from "~/components/rpc";

import { keepDates } from "./fixtures/todo/codec";
import { api, board } from "./fixtures/todo/contracts";
import { addTodo, joinPresence, removeTodo, signedIn, toggleTodo } from "./fixtures/todo/data";
import { sseClient, sseServer } from "./support/sse";

const sse = { client: sseClient.client, server: sseServer.server };

// Tests wire their own scopes, as server.ts and main.tsx do; browser.test.ts runs those two whole.

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const closers: Array<() => unknown> = [];

afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

type Scope = ReturnType<typeof createScope>;

async function boot(kind: "memory" | "sse") {
  const transport = sse.server({ base: "/api", codec: keepDates, services: [board, api] });
  const server = createScope({
    capsules: [
      board({ serve: true, use: [signedIn] }),
      api({
        use: [signedIn],
        implement: {
          "todo.add": addTodo,
          "todo.toggle": toggleTodo,
          "todo.remove": removeTodo,
          "presence.join": joinPresence,
        },
      }),
      transport,
      memory.server({ codec: keepDates, services: [board, api] }),
    ],
  });
  await server.ready;
  closers.push(() => server.close());
  let base = "";
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
  /** A client scope, as main.tsx builds it; not waited, so a refused start can be read.
   *  Clients take turns: whole or delta pushes, each stream or one shared stream. */
  let count = 0;
  const open = (who?: string) => {
    const headers: Record<string, string> = who ? { cookie: `sid=${who}` } : {};
    const turn = count++;
    const pushes = turn % 2 ? "delta" : "whole";
    const streams = turn % 4 >= 2 ? "one" : "each";
    const options = { codec: keepDates, headers, pushes, streams } as const;
    const transport = kind === "memory" ? memory.client : sse.client;
    const client = createScope({
      capsules: [
        kind === "memory"
          ? memory.client({ peer: server, ...options })
          : sse.client({ base, ...options }),
        board({ read: transport }),
        api({ remote: transport }),
      ],
    });
    let closed = false;
    const close = () => (closed ? undefined : ((closed = true), client.close()));
    closers.push(close);

    return Object.assign(client, { end: close });
  };
  const join = async (who: string) => {
    const client = open(who);
    await client.ready;
    return client;
  };
  /** Online until the client closes, as main.tsx does. */
  const online = (client: Scope) =>
    void client
      .run(api["presence.join"], { input: null })
      .then(async (s) => {
        for await (const _ of s);
      })
      .catch(() => undefined);

  return { server, open, join, online, base };
}

const titles = (s: Scope) =>
  s
    .resolve(board.todos)
    .get()
    .map((t) => t.title);

const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await tick(10);
  }
};

for (const kind of ["memory", "sse"] as const) {
  describe(kind, () => {
    test("a signed-in client is ready with every basket filled", async () => {
      const { join } = await boot(kind);
      const duke = await join("duke");
      expect(duke.resolve(board.todos).get()).toEqual([]);
      expect(duke.resolve(board.people).get()).toEqual([]);
      expect(duke.resolve(board.activity).get()).toEqual([]);
    });

    test("a guest: the client starts; the board shows its own fault, refused, as data", async () => {
      const { open } = await boot(kind);
      const guest = open();
      await guest.ready; // a fault never fails start, so the scope stays open
      expect(guest.resolve(board.todos).get()).toEqual([]); // the cell keeps its initial value
      const error = guest.resolve(board.faults).get().todos;

      expect(board.fault.is(error)).toBe(true);
      expect(api.fault.is(error)).toBe(false); // another definition's brand
      expect(error).toMatchObject({
        address: "todos",
        fault: "refused",
        payload: { signIn: true },
      });
      // The scope still works: a call answers its own fault, not Disposed.
      const call = await guest.run(api["todo.add"], { input: { title: "x" } }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(call).toMatchObject({ fault: "refused", payload: { signIn: true } });
    });

    test("one user adds; every user sees the todo and the activity line", async () => {
      const { join } = await boot(kind);
      const duke = await join("duke");
      const ann = await join("ann");
      await duke.run(api["todo.add"], { input: { title: "Write the ADR" } });
      await until(() => titles(ann).length === 1);
      const [item] = ann.resolve(board.todos).get();

      expect(item).toMatchObject({ title: "Write the ADR", by: "duke", done: false });
      expect(item!.at).toBeInstanceOf(Date); // the protocol's codec
      await until(() => ann.resolve(board.activity).get().length === 1); // its own stream: may land after todos (F35)
      expect(ann.resolve(board.activity).get()[0]).toMatchObject({
        who: "duke",
        what: 'added "Write the ADR"',
      });
    });

    test("toggle and remove from another user; a stale id answers gone, as output", async () => {
      const { join } = await boot(kind);
      const duke = await join("duke");
      const ann = await join("ann");
      const { id } = await duke.run(api["todo.add"], { input: { title: "Ship" } });
      await ann.run(api["todo.toggle"], { input: { id } });
      await until(() => duke.resolve(board.todos).get()[0]?.done === true);
      await ann.run(api["todo.remove"], { input: { id } });
      await until(() => titles(duke).length === 0);

      const stale = await duke.run(api["todo.toggle"], { input: { id } }); // a value, typed by the output shape
      expect(stale).toEqual({ kind: "gone", id });
      expect(
        duke
          .resolve(board.activity)
          .get()
          .map((e) => e.what),
      ).toEqual(['removed "Ship"', 'finished "Ship"', 'added "Ship"']);
    });

    test("presence: a user is online while any of their clients is open", async () => {
      const { join, online } = await boot(kind);
      const watcher = await join("eve");
      const duke1 = await join("duke");
      const duke2 = await join("duke");
      online(duke1);
      online(duke2);
      await until(() => watcher.resolve(board.people).get().join() === "duke");
      await duke1.end();
      await tick(80);

      expect(watcher.resolve(board.people).get()).toEqual(["duke"]); // duke2 still open
      await duke2.end();
      await until(() => watcher.resolve(board.people).get().length === 0);
    });

    test("stress: 4 users x 5 clients, 20 ops each at once; every client ends equal to the server", async () => {
      const { server, join, online } = await boot(kind);
      const users = ["ann", "bob", "cat", "duke"];
      const clients = await Promise.all(
        users.flatMap((u) => Array.from({ length: 5 }, () => join(u))),
      );
      clients.forEach(online);
      const started = performance.now();
      let calls = 0;
      await Promise.all(
        clients.map(async (c, n) => {
          const mine: string[] = [];
          for (let i = 0; i < 20; i++) {
            calls++;
            if (i % 4 === 3 && mine.length) {
              await c.settle(api["todo.remove"], { input: { id: mine.shift()! } });
            } else if (i % 4 === 1) {
              const any = c.resolve(board.todos).get();
              if (any.length) {
                await c.settle(api["todo.toggle"], {
                  input: { id: any[(n + i) % any.length]!.id },
                });
              }
            } else {
              mine.push((await c.run(api["todo.add"], { input: { title: `c${n}-${i}` } })).id);
            }
          }
        }),
      );
      const took = performance.now() - started;
      const truth = JSON.stringify(server.resolve(board.todos).get());
      await until(
        () => clients.every((c) => JSON.stringify(c.resolve(board.todos).get()) === truth),
        5000,
      );
      await until(() =>
        clients.every((c) => c.resolve(board.people).get().join() === users.join()),
      );
      const done = server.resolve(board.todos).get();

      expect(done.length).toBe(100); // 20 clients x (10 adds - 5 removes)
      expect(new Set(done.map((t) => t.id)).size).toBe(done.length);
      // Each basket has its own stream, so activity may land a moment after todos; it must still land.
      await until(
        () =>
          clients.every(
            (c) =>
              JSON.stringify(c.resolve(board.activity).get()) ===
              JSON.stringify(server.resolve(board.activity).get()),
          ),
        5000,
      );
      console.log(
        `${kind}: ${calls} calls from 20 clients in ${took.toFixed(0)} ms; ${done.length} todos; all 20 clients equal`,
      );
      await Promise.all(clients.map(async (c) => c.end()));
      await until(() => server.resolve(board.people).get().length === 0);
    }, 20_000);
  });
}

test("on the wire: one transport, rpc and the board on the same routes and codec", async () => {
  const { base } = await boot("sse");
  const headers = { cookie: "sid=duke" };
  const added = await fetch(`${base}/todo.add`, {
    method: "POST",
    body: '{"title":"Raw"}',
    headers,
  });

  expect(await added.text()).toMatch(/^\{"ok":true,"value":\{"id":"[0-9a-f-]+"\}\}$/);
  const read = await (
    await fetch(`${base}/todos`, { method: "POST", body: "null", headers })
  ).text();
  expect(read).toMatch(
    /^\{"ok":true,"value":\[\{"id":"[^"]+","title":"Raw","done":false,"by":"duke","at":\{"\$date":"[^"]+"\}\}\]\}$/,
  );
  const guest = await (await fetch(`${base}/todos`, { method: "POST", body: "null" })).text();
  expect(guest).toBe('{"ok":false,"kind":"refused","payload":{"signIn":true}}');
});

describe("one rpc capsule: the same handle on both sides", () => {
  test("the server runs api['todo.add'] here, through use; clients see it", async () => {
    const { server, join } = await boot("memory");
    const ann = await join("ann");
    const as = (who?: string) =>
      server.createSession({
        tags: [
          routes.request(
            new Request("http://test/", { headers: who ? { cookie: `sid=${who}` } : {} }),
          ),
        ],
      });
    const job = as("duke");
    const { id } = await job.run(api["todo.add"], { input: { title: "From the server" } });
    await job.close();
    await until(() => titles(ann).join() === "From the server");

    expect(ann.resolve(board.todos).get()[0]).toMatchObject({ id, by: "duke" });
    const guest = as();
    const refused = Object(await guest.settle(api["todo.add"], { input: { title: "x" } })).error;
    expect(api.fault.is(refused) && refused.fault).toBe("refused");
    expect(
      Object(await guest.settle(api["todo.add"], { input: { title: "" } })).error,
    ).toMatchObject({ kind: "DataValidationFailed" });
    await guest.close();
  });

  test("a stream runs here too: online while read, gone after break", async () => {
    const { server, join } = await boot("memory");
    const ann = await join("ann");
    const job = server.createSession({
      tags: [routes.request(new Request("http://test/", { headers: { cookie: "sid=bot" } }))],
    });
    for await (const count of await job.run(api["presence.join"], { input: null })) {
      expect(count).toBe(1);
      await until(() => ann.resolve(board.people).get().join() === "bot");
      break;
    }
    await until(() => ann.resolve(board.people).get().length === 0);

    await job.close();
  });

  test("api: one job, implement or remote; both or neither fails start", async () => {
    // @ts-expect-error: neither
    expect(createScope({ capsules: [api({})] }).ready).rejects.toMatchObject({
      kind: "MissingConfig",
      payload: { key: "implement | remote" },
    });
    const both = createScope({
      capsules: [
        // @ts-expect-error: both
        api({
          remote: memory.client,
          implement: {
            "todo.add": addTodo,
            "todo.toggle": toggleTodo,
            "todo.remove": removeTodo,
            "presence.join": joinPresence,
          },
        }),
      ],
    });
    expect(both.ready).rejects.toMatchObject({ kind: "MissingConfig" });
    expect(() => rpc({ answer: { input: z.null(), output: z.null() } })).toThrow(
      '"answer" is a reserved key',
    );
  });
});
