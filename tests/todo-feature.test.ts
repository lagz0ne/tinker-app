import { createScope } from "@tinker/core";
import { memory } from "@tinker/core/testing";
import { afterEach, expect, test } from "vite-plus/test";

import { api } from "@/api";
import { greetHere } from "@/backend/greet";
import { todoApi, todoBoard } from "@/todo/contract";
import { todoOps } from "@/todo/ops.server";

// The todo feature as the two cmds install it: the server serves the board and implements the
// api; each tab reads the board and calls the api. Over `memory`, the same protocol as the socket.

const closers: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function boot() {
  const services = [api, todoBoard, todoApi];
  const server = await createScope({
    capsules: [
      api({ implement: { greet: greetHere } }),
      todoBoard({ serve: true }),
      todoApi({ implement: todoOps }),
      memory.server({ services }),
    ],
  }).ready;
  closers.push(() => server.close());

  const tab = async () => {
    const scope = await createScope({
      capsules: [
        memory.client({ peer: server }),
        api({ remote: memory.client }),
        todoBoard({ read: memory.client }),
        todoApi({ remote: memory.client }),
      ],
    }).ready;
    closers.push(() => scope.close());
    return scope;
  };

  return { server, tab };
}

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
  const { id } = await a.run(todoApi["todo.add"], { input: { title: "Ship the template" } });

  await until(() => b.resolve(todoBoard.todos).get().length === 1);
  expect(b.resolve(todoBoard.todos).get()).toEqual([
    { id, title: "Ship the template", done: false },
  ]);
});

test("toggle and remove land on every tab; a stale id answers gone, as output", async () => {
  const { tab } = await boot();
  const [a, b] = [await tab(), await tab()];
  const { id } = await a.run(todoApi["todo.add"], { input: { title: "Write the test" } });

  expect(await b.run(todoApi["todo.toggle"], { input: { id } })).toEqual({
    kind: "toggled",
    done: true,
  });
  await until(() => a.resolve(todoBoard.todos).get()[0]?.done === true);
  expect(await b.run(todoApi["todo.remove"], { input: { id } })).toEqual({ kind: "removed" });
  await until(() => a.resolve(todoBoard.todos).get().length === 0);
  expect(await a.run(todoApi["todo.toggle"], { input: { id } })).toEqual({ kind: "gone", id });
});

test("an empty title is refused by the contract on the tab: the server never sees it", async () => {
  const { server, tab } = await boot();
  const a = await tab();
  await expect(async () => a.run(todoApi["todo.add"], { input: { title: "  " } })).rejects.toThrow(
    "DataValidationFailed",
  );
  expect(server.resolve(todoBoard.todos).get()).toEqual([]);
});

test("the greet api and the todo api live side by side in one scope", async () => {
  const { tab } = await boot();
  const a = await tab();
  expect(await a.run(api.greet, { input: { name: "todo" } })).toEqual({ text: "Hello, todo." });
});
