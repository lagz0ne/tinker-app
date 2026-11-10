import { useData, useRun } from "@tinker/react";

import { todoApi, todoBoard } from "./contract";

/** The todo page: reads the live list, and asks the server for every change. No state of its own. */
export function TodoList() {
  const list = useData(todoBoard.todos);
  const add = useRun(todoApi["todo.add"]);
  const toggle = useRun(todoApi["todo.toggle"]);
  const remove = useRun(todoApi["todo.remove"]);

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
          <li key={item.id}>
            <label>
              <input
                type="checkbox"
                checked={item.done}
                onChange={() => toggle.run({ input: { id: item.id } })}
              />
              {item.title}
            </label>
            <button type="button" onClick={() => remove.run({ input: { id: item.id } })}>
              Remove
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
