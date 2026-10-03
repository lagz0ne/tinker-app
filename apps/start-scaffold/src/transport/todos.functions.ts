import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { listTodos, changeTodo } from "../backend/index.ts";
import { readTodoCommand } from "../contracts/commands.ts";
import { startRequests } from "../scaffold/start.ts";
import { readResult } from "../scaffold/backend/result.server.ts";
import { readReceipt } from "./result.server.ts";
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
