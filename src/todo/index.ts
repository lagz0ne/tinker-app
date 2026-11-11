import { capsule } from "@tinker/core";

import { todoApi, todoBoard } from "./contract";

export type { Todo } from "./contract";
export { TodoList, TodoRow } from "./todo-list";

/**
 * The todo feature's one door: other features and the cmds import `@/todo` only.
 * - `board`: the live list (remote data, keyed). Read `todo.board.todos.where({})` for every todo,
 *   or `.of({ id })` for one: a read view (ADR 0123), so only this feature's ops write the list.
 * - `api`: every change, as a call (rpc). Others ask; they never write.
 */
export const todo = capsule({ label: "todo", exports: { board: todoBoard, api: todoApi } });
