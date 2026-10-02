import { operation } from "@tinker/core";
import { database } from "./database.ts";
import { currentUser } from "./auth.ts";
import { readTodoCommand } from "../contracts/commands.ts";
import { eventHistory } from "../scaffold/backend/events.ts";
import type { Todos } from "../contracts/todos.ts";
import type { Sync } from "../contracts/sync.ts";
import { raise } from "../errors.ts";
export const listTodos = operation({
  label: "listTodos",
  depends: { currentUser, database },
  run: async ({ currentUser, database }): Promise<Todos.Row[]> => {
    const [{ asc, eq }, { todo }] = await Promise.all([
      import("drizzle-orm"),
      import("./todos.schema.ts"),
    ]);
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
  run: async ({ currentUser, database, history }, ctx) => {
    const [{ and, asc, eq }, { todo }, { execution }] = await Promise.all([
      import("drizzle-orm"),
      import("./todos.schema.ts"),
      import("./sync.schema.ts"),
    ]);
    await database.transaction(async (tx) => {
      await history.lock(tx, currentUser.id);
      if (await history.find(tx, ctx.input.executionId, currentUser.id)) return;
      const change = ctx.input.change;
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
      await tx.insert(execution).values({ id: ctx.input.executionId, stream: currentUser.id });
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
      await history.append(tx, currentUser.id, ctx.input.executionId, payloads);
    });
    return { executionId: ctx.input.executionId };
  },
});
