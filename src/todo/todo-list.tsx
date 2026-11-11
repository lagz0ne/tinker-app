import { useData, useRun } from "@tinker/react";
import { memo } from "react";

import { todoApi, todoBoard } from "./contract";

/** The todo page: reads the live list, and asks the server for every change. No state of its own. */
export function TodoList() {
  const list = useData(todoBoard.todos.where({}));
  const add = useRun(todoApi["todo.add"]);

  return (
    <main>
      <h1>Todo</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const title = form.elements.namedItem("title") as HTMLInputElement;
          add.run({ input: { title: title.value } });
          form.reset();
        }}
      >
        <input name="title" aria-label="New todo" placeholder="What next?" />
        <button type="submit">Add</button>
      </form>
      <ul>
        {list.map((item) => (
          <TodoRow key={item.id} id={item.id} />
        ))}
      </ul>
    </main>
  );
}

/**
 * One todo: it reads its own member, so a toggle draws this row alone. It rides the list's
 * stream: a part inside a part in use opens no stream of its own.
 */
export const TodoRow = memo(function TodoRow({ id }: { id: string }) {
  const item = useData(todoBoard.todos.of({ id }));
  const toggle = useRun(todoApi["todo.toggle"]);
  const remove = useRun(todoApi["todo.remove"]);
  if (!item) return null;

  return (
    <li>
      <label>
        <input type="checkbox" checked={item.done} onChange={() => toggle.run({ input: { id } })} />
        {item.title}
      </label>
      <button type="button" onClick={() => remove.run({ input: { id } })}>
        Remove
      </button>
    </li>
  );
});
