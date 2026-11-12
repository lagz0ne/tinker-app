import { createScope } from "@tinkered/core";
import { memory } from "@tinkered/core/testing";
import { ScopeProvider, useData } from "@tinkered/react";
import { memo, Profiler } from "react";
import type { ProfilerOnRenderCallback } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { todo } from "@/todo";
import { TodoList, TodoRow } from "@/todo";
import { todoOps } from "@/todo/index.server";

// In a real Chromium: the page asks the server through `todoApi`, and draws the list the server
// pushes through `todoBoard`. The server here is a scope in the same page, over `memory`.

test("add, toggle and remove a todo from the page; the server holds each change", async () => {
  const server = await createScope({
    capsules: [
      todo.board({ serve: true }),
      todo.api({ implement: todoOps }),
      memory.server({ services: [todo.board, todo.api] }),
    ],
  }).ready;
  const tab = await createScope({
    capsules: [
      memory.client({ peer: server }),
      todo.board({ read: memory.client }),
      todo.api({ remote: memory.client }),
    ],
  }).ready;
  const box = document.body.appendChild(document.createElement("div"));
  const root = createRoot(box);
  root.render(
    <ScopeProvider scope={tab}>
      <TodoList />
    </ScopeProvider>,
  );

  await page.getByLabelText("New todo").fill("Try the template");
  await page.getByRole("button", { name: "Add" }).click();
  await expect.element(page.getByText("Try the template")).toBeVisible();

  await page.getByRole("checkbox").click();
  await expect.poll(() => server.resolve(todo.board.todos).get()[0]?.done).toBe(true);

  await page.getByRole("button", { name: "Remove" }).click();
  await expect.element(page.getByText("Try the template")).not.toBeInTheDocument();
  expect(server.resolve(todo.board.todos).get()).toEqual([]);

  root.unmount();
  await tab.close();
  await server.close();
});

test("a toggle draws the toggled row alone", async () => {
  const server = await createScope({
    capsules: [
      todo.board({ serve: true }),
      todo.api({ implement: todoOps }),
      memory.server({ services: [todo.board, todo.api] }),
    ],
  }).ready;
  for (const title of ["one", "two", "three"]) {
    server.run(todoOps["todo.add"], { input: { title } });
  }
  const tab = await createScope({
    capsules: [
      memory.client({ peer: server }),
      todo.board({ read: memory.client }),
      todo.api({ remote: memory.client }),
    ],
  }).ready;
  const draws = new Map<string, number>();
  const count: ProfilerOnRenderCallback = (id) => void draws.set(id, (draws.get(id) ?? 0) + 1);
  // A Profiler draws again with its parent, so each one sits in a memo, as TodoRow does: it then
  // reports only a row that draws for its own member.
  const Counted = memo(function Counted({ id, title }: { id: string; title: string }) {
    return (
      <Profiler id={title} onRender={count}>
        <TodoRow id={id} />
      </Profiler>
    );
  });
  // The rows as TodoList draws them: under a parent that draws again at each change of the list.
  function Rows() {
    const list = useData(todo.board.todos.where({}));
    return (
      <ul>
        {list.map((item) => (
          <Counted key={item.id} id={item.id} title={item.title} />
        ))}
      </ul>
    );
  }
  const box = document.body.appendChild(document.createElement("div"));
  const root = createRoot(box);
  root.render(
    <ScopeProvider scope={tab}>
      <Rows />
    </ScopeProvider>,
  );
  await expect.element(page.getByText("three")).toBeVisible();
  draws.clear();

  await page.getByRole("checkbox", { name: "two" }).click();
  await expect.poll(() => server.resolve(todo.board.todos).get()[1]?.done).toBe(true);
  await expect.element(page.getByRole("checkbox", { name: "two" })).toBeChecked();

  expect([...draws.keys()]).toEqual(["two"]);
  root.unmount();
  await tab.close();
  await server.close();
});
