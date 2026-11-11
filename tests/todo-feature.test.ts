import { createScope, operation } from "@tinker/core";
import type { Scope } from "@tinker/core";
import { memory } from "@tinker/core/testing";
import { afterEach, expect, test } from "vite-plus/test";
import { z } from "zod";

import { greet } from "@/greet";
import { greetOps } from "@/greet/index.server";
import { todo } from "@/todo";
import { todoOps } from "@/todo/index.server";

// The todo feature as the two cmds install it: the server serves the board and implements the
// api; each tab reads the board and calls the api. Over `memory`, the same protocol as the socket.

const closers: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function boot() {
  const services = [greet.api, todo.board, todo.api];
  const server = await createScope({
    capsules: [
      greet.api({ implement: greetOps }),
      todo.board({ serve: true }),
      todo.api({ implement: todoOps }),
      memory.server({ services }),
    ],
  }).ready;
  closers.push(() => server.close());

  const tab = async () => {
    const scope = await createScope({
      capsules: [
        memory.client({ peer: server }),
        greet.api({ remote: memory.client }),
        todo.board({ read: memory.client }),
        todo.api({ remote: memory.client }),
      ],
    }).ready;
    closers.push(() => scope.close());
    return scope;
  };

  return { server, tab };
}

/** A tab's reader of every todo, kept in use: a keyed board serves only the parts a tab reads. */
const everyTodo = (scope: Scope.Handle) => {
  const reader = scope.resolve(todo.board.todos.where({}));
  reader.watch(() => undefined);
  return reader;
};

const until = async (ok: () => boolean) => {
  const end = Date.now() + 3000;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("one tab adds; the other tab sees it, with no read of its own", async () => {
  const { tab } = await boot();
  const [a, b] = [await tab(), await tab()];
  const seen = everyTodo(b);
  const { id } = await a.run(todo.api["todo.add"], { input: { title: "Ship the template" } });

  await until(() => seen.get().length === 1);
  expect(seen.get()).toEqual([{ id, title: "Ship the template", done: false }]);
});

test("toggle and remove land on every tab; a stale id answers gone, as output", async () => {
  const { tab } = await boot();
  const [a, b] = [await tab(), await tab()];
  const seen = everyTodo(a);
  const { id } = await a.run(todo.api["todo.add"], { input: { title: "Write the test" } });

  expect(await b.run(todo.api["todo.toggle"], { input: { id } })).toEqual({
    kind: "toggled",
    done: true,
  });
  await until(() => seen.get()[0]?.done === true);
  expect(await b.run(todo.api["todo.remove"], { input: { id } })).toEqual({ kind: "removed" });
  await until(() => seen.get().length === 0);
  expect(await a.run(todo.api["todo.toggle"], { input: { id } })).toEqual({ kind: "gone", id });
});

test("an empty title is refused by the contract on the tab: the server never sees it", async () => {
  const { server, tab } = await boot();
  const a = await tab();
  await expect(async () => a.run(todo.api["todo.add"], { input: { title: "  " } })).rejects.toThrow(
    "DataValidationFailed",
  );
  expect(server.resolve(todo.board.todos).get()).toEqual([]);
});

test("the greet api and the todo api live side by side in one scope", async () => {
  const { tab } = await boot();
  const a = await tab();
  expect(await a.run(greet.api.greet, { input: { name: "todo" } })).toEqual({
    text: "Hello, todo.",
  });
});

/** Another feature's op, as `src/stats` would write it: it reaches todo through the door only. */
const openCount = operation({
  label: "stats.open",
  input: z.null(),
  depends: { list: todo.board.todos },
  run: ({ list }) => list.get().filter((t) => !t.done).length,
});

test("another feature reads the list through the door, on either side, and cannot write it", async () => {
  const { server, tab } = await boot();
  const a = await tab();
  const seen = everyTodo(a);
  await a.run(todo.api["todo.add"], { input: { title: "Read me" } });
  await until(() => seen.get().length === 1);

  expect(a.run(openCount, { input: null })).toBe(1);
  expect(server.run(openCount, { input: null })).toBe(1);
  // @ts-expect-error the door shows a read view: no controller, so no write from outside
  expect(todo.board.todos.controller).toBeUndefined();
});

test("with 1,000 todos, one toggle sends one member over the wire, not the list", async () => {
  let bytes = 0;
  const counted = {
    serialize: (value: unknown) => {
      const text = JSON.stringify(value ?? null);
      bytes += text.length;
      return text;
    },
    deserialize: (text: string) => JSON.parse(text) as unknown,
  };
  const services = [todo.board, todo.api];
  const server = await createScope({
    capsules: [
      todo.board({ serve: true }),
      todo.api({ implement: todoOps }),
      memory.server({ services, codec: counted }),
    ],
  }).ready;
  closers.push(() => server.close());
  for (let i = 0; i < 1000; i++) {
    server.run(todoOps["todo.add"], { input: { title: `todo number ${i}` } });
  }
  const tab = await createScope({
    capsules: [
      memory.client({ peer: server, codec: counted }),
      todo.board({ read: memory.client }),
      todo.api({ remote: memory.client }),
    ],
  }).ready;
  closers.push(() => tab.close());
  const seen = everyTodo(tab);
  await until(() => seen.get().length === 1000);
  const list = bytes;
  const { id } = seen.get()[500]!;
  const row = tab.resolve(todo.board.todos.of({ id }));
  row.watch(() => undefined);

  bytes = 0;
  await tab.run(todo.api["todo.toggle"], { input: { id } });
  await until(() => row.get()?.done === true);
  await new Promise((r) => setTimeout(r, 30));

  expect(list).toBeGreaterThan(50_000);
  expect(bytes).toBeLessThan(1_000);
});
