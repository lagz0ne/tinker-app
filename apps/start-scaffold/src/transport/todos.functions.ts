import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";

import { readTodoCommand } from "~/components/demo";
import { listTodos, changeTodo } from "~/components/demo/index.server";
import { startRequests } from "~/components/requests";
import { readResult } from "~/components/requests/index.server";

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
