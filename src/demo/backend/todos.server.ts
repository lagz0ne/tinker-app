import { operation } from "@tinker/core";

import { drizzleOrm } from "~/components/database/index.server";
import { database, transaction } from "~/components/database/index.server";
import type { Sync } from "~/components/sync";
import { eventHistory, execution } from "~/components/sync/index.server";

import { readTodoCommand } from "@/demo/contracts/commands";
import { readTodoChange, todoRefusal } from "@/demo/contracts/todos-contract";
import type { Todos } from "@/demo/contracts/todos-contract";
import type { Errors } from "@/demo/errors";

import { currentUser } from "./auth.server";
import { todo } from "./todos.schema.server";

export const listTodos = operation({
  label: "listTodos",
  depends: { orm: drizzleOrm, currentUser, database },
  run: ({ orm, currentUser, database }): Promise<Todos.Row[]> => {
    const { asc, eq } = orm;
    return database
      .select({ id: todo.id, title: todo.title, done: todo.done })
      .from(todo)
      .where(eq(todo.ownerId, currentUser.id))
      .orderBy(asc(todo.id));
  },
});

export const changeTodo = operation({
  label: "changeTodo",
  input: readTodoCommand,
  depends: { orm: drizzleOrm, currentUser, tx: transaction, history: eventHistory },
  run: async ({ orm, currentUser, tx, history }, { input, raise: coreRaise }) => {
    const raise: Errors.Raise = coreRaise;

    const parsed = readTodoChange.safeParse(input.change);
    if (!parsed.success) {
      return raise("BadInput", { reason: todoRefusal });
    }
    const change = parsed.data;
    const { and, asc, eq } = orm;

    await history.lock(tx, currentUser.id);
    if (await history.find(tx, input.executionId, currentUser.id)) {
      return { executionId: input.executionId };
    }

    let changed = true;
    if (change.kind === "add") {
      await tx.insert(todo).values({ ownerId: currentUser.id, title: change.title });
    } else {
      const owned = and(eq(todo.id, change.id), eq(todo.ownerId, currentUser.id));
      const row = (await tx.select().from(todo).where(owned)).at(0);
      if (!row) {
        return raise("TodoMissing", {});
      }
      if (change.kind === "delete") await tx.delete(todo).where(owned);
      else if (row.done !== change.done) {
        await tx.update(todo).set({ done: change.done }).where(owned);
      } else changed = false;
    }

    await tx.insert(execution).values({ id: input.executionId, stream: currentUser.id });

    const payloads: Sync.Payload[] = [];
    if (changed) {
      const rows = await tx
        .select({ id: todo.id, title: todo.title, done: todo.done })
        .from(todo)
        .where(eq(todo.ownerId, currentUser.id))
        .orderBy(asc(todo.id));
      payloads.push({ kind: "change", change: { kind: "todos", rows } });
    }

    payloads.push({ kind: "result", result: { kind: "complete", action: "todo" } });
    await history.append(tx, currentUser.id, input.executionId, payloads);

    return { executionId: input.executionId };
  },
});
