import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";

import { startRequests } from "~/components/requests";
import { readResult } from "~/components/requests/index.server";

import { listTodos, changeTodo } from "@/demo/backend/todos.server";
import { readTodoCommand } from "@/demo/contracts/commands";

import { readReceipt } from "./result.server";

export const getTodos = createServerFn({ method: "GET" })
  .middleware([startRequests.middleware])
  .handler(async ({ context }) => {
    setResponseHeader("Cache-Control", "no-store");
    return readResult(await context.session.settle(listTodos, { signal: context.signal }));
  });

export const updateTodo = createServerFn({ method: "POST" })
  .middleware([startRequests.middleware])
  .validator(readTodoCommand)
  .handler(async ({ context, data }) =>
    readReceipt(await context.session.settle(changeTodo, { input: data, signal: context.signal })),
  );
