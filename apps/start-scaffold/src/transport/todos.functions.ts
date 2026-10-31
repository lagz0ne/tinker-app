import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";

import { startRequests } from "~/components/requests";

import { readTodoCommand } from "@/demo/contracts/commands";

import { todoList, todoReceipt } from "./result.server";

export const getTodos = createServerFn({ method: "GET" })
  .middleware([startRequests.middleware])
  .handler(async ({ context }) => {
    setResponseHeader("Cache-Control", "no-store");
    return context.session.run(todoList);
  });

export const updateTodo = createServerFn({ method: "POST" })
  .middleware([startRequests.middleware])
  .validator(readTodoCommand)
  .handler(async ({ context, data }) => context.session.run(todoReceipt, { input: data }));
