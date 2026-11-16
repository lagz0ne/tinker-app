import { capsule } from "@tinkered/core";

import { todoApi, todoBoard } from "./contract";

/**
 * The todo feature's capsule. Others import a file of the feature by its own path (ADR 0160).
 * - `board`: the live list (remote data, keyed). Read `todo.board.todos.where({})` for every todo,
 *   or `.of({ id })` for one: a read view (ADR 0123), so only this feature's ops write the list.
 * - `api`: every change, as a call (rpc). Others ask; they never write.
 */
export const todo = capsule({ label: "todo", exports: { board: todoBoard, api: todoApi } });
