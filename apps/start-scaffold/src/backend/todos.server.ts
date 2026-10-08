import { and, asc, eq } from "drizzle-orm";
import { todo } from "./todos.schema.server";
import { operation } from "@tinker/core";
import { database } from "./database.server";
import { currentUser } from "./auth.server";
import { readTodoCommand } from "../contracts/commands";
import { eventHistory, execution } from "@tinker/start/server";
import type { Todos } from "../contracts/todos";
import type { Sync } from "../contracts/sync";
import { raise } from "../errors";

export const listTodos = operation({
  label: "listTodos",
  depends: { currentUser, database },
  run: ({ currentUser, database }): Promise<Todos.Row[]> => {
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
  depends: { currentUser, database, history: eventHistory },
  run: async ({ currentUser, database, history }, { input }) => {
    await database.transaction(async (tx) => {
      await history.lock(tx, currentUser.id);
      if (await history.find(tx, input.executionId, currentUser.id)) return;
      const change = input.change;
      let changed = true;
      if (change.kind === "add")
        await tx.insert(todo).values({ ownerId: currentUser.id, title: change.title });
      else {
        const owned = and(eq(todo.id, change.id), eq(todo.ownerId, currentUser.id));
        const row = (await tx.select().from(todo).where(owned)).at(0);
        if (!row) raise("TodoMissing", {});
        if (change.kind === "delete") await tx.delete(todo).where(owned);
        else if (row.done !== change.done)
          await tx.update(todo).set({ done: change.done }).where(owned);
        else changed = false;
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
    });
    return { executionId: input.executionId };
  },
});
