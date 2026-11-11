import { operation } from "@tinker/core";
import { z } from "zod";

import { todos } from "./contract";

// The server's work for `todoApi`. Each op writes one member of the list; `todoBoard` tells every
// tab that reads it, and the tab asks for that member alone. No op sends anything by hand.

export const addTodo = operation({
  label: "todo.add.do",
  input: z.object({ title: z.string() }),
  depends: { list: todos.controller },
  run: ({ list }, { input, random }) => {
    const id = random.uuid();
    list.set({ id, title: input.title, done: false });
    return { id };
  },
});

export const toggleTodo = operation({
  label: "todo.toggle.do",
  input: z.object({ id: z.string() }),
  depends: { list: todos.controller },
  run: ({ list }, { input }) => {
    const item = list.of({ id: input.id }).get();
    if (!item) return { kind: "gone" as const, id: input.id };
    list.update({ id: input.id }, (t) => ({ ...t, done: !t.done }));
    return { kind: "toggled" as const, done: !item.done };
  },
});

export const removeTodo = operation({
  label: "todo.remove.do",
  input: z.object({ id: z.string() }),
  depends: { list: todos.controller },
  run: ({ list }, { input }) => {
    if (!list.of({ id: input.id }).get()) return { kind: "gone" as const, id: input.id };
    list.delete({ id: input.id });
    return { kind: "removed" as const };
  },
});

/** The server's side of `todoApi`, by address: `todoApi({ implement: todoOps })`. */
export const todoOps = {
  "todo.add": addTodo,
  "todo.toggle": toggleTodo,
  "todo.remove": removeTodo,
} as const;
