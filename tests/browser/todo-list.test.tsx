import { createScope } from "@tinker/core";
import { memory } from "@tinker/core/testing";
import { ScopeProvider } from "@tinker/react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

import { todoApi, todoBoard } from "@/todo/contract";
import { todoOps } from "@/todo/ops.server";
import { TodoList } from "@/todo/todo-list";

// In a real Chromium: the page asks the server through `todoApi`, and draws the list the server
// pushes through `todoBoard`. The server here is a scope in the same page, over `memory`.

test("add, toggle and remove a todo from the page; the server holds each change", async () => {
  const server = await createScope({
    capsules: [
      todoBoard({ serve: true }),
      todoApi({ implement: todoOps }),
      memory.server({ services: [todoBoard, todoApi] }),
    ],
  }).ready;
  const tab = await createScope({
    capsules: [
      memory.client({ peer: server }),
      todoBoard({ read: memory.client }),
      todoApi({ remote: memory.client }),
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
  await expect.poll(() => server.resolve(todoBoard.todos).get()[0]?.done).toBe(true);

  await page.getByRole("button", { name: "Remove" }).click();
  await expect.element(page.getByText("Try the template")).not.toBeInTheDocument();
  expect(server.resolve(todoBoard.todos).get()).toEqual([]);

  root.unmount();
  await tab.close();
  await server.close();
});
