import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { listTodos, changeTodo } from "../backend/index";
import { readTodoCommand } from "../contracts/commands";
import { startRequests } from "@tinker/start";
import { readResult } from "@tinker/start/server";
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
