import { operation } from "@tinker/core";
import { z } from "zod";

import { todos } from "./contract";

// The server's work for `todoApi`. Each op writes the one list cell; `todoBoard` pushes the new
// list to every tab that reads it, so no op sends anything by hand.

export const addTodo = operation({
  label: "todo.add.do",
  input: z.object({ title: z.string() }),
  depends: { list: todos.controller },
  run: ({ list }, { input, random }) => {
    const id = random.uuid();
    list.set([...list.get(), { id, title: input.title, done: false }]);
    return { id };
  },
});

export const toggleTodo = operation({
  label: "todo.toggle.do",
  input: z.object({ id: z.string() }),
  depends: { list: todos.controller },
  run: ({ list }, { input }) => {
    const item = list.get().find((t) => t.id === input.id);
    if (!item) return { kind: "gone" as const, id: input.id };
    list.set(list.get().map((t) => (t.id === input.id ? { ...t, done: !t.done } : t)));
    return { kind: "toggled" as const, done: !item.done };
  },
});

export const removeTodo = operation({
  label: "todo.remove.do",
  input: z.object({ id: z.string() }),
  depends: { list: todos.controller },
  run: ({ list }, { input }) => {
    if (!list.get().some((t) => t.id === input.id)) return { kind: "gone" as const, id: input.id };
    list.set(list.get().filter((t) => t.id !== input.id));
    return { kind: "removed" as const };
  },
});

/** The server's side of `todoApi`, by address: `todoApi({ implement: todoOps })`. */
export const todoOps = {
  "todo.add": addTodo,
  "todo.toggle": toggleTodo,
  "todo.remove": removeTodo,
} as const;
