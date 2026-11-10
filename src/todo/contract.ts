import { data, remoteData, rpc } from "@tinker/core";
import { z } from "zod";

// The todo feature's contract: both sides import it. What can be read (`todoBoard`, remote data)
// and what can be asked (`todoApi`, rpc). Both are capsules: each cmd installs them with its side's
// config, the server with `serve` and `implement`, the tab with `read` and `remote`.

const todo = z.object({ id: z.string(), title: z.string(), done: z.boolean() });
export type Todo = z.infer<typeof todo>;

/** A todo that is no longer there: a domain outcome, so it is part of the output shape. */
const gone = z.object({ kind: z.literal("gone"), id: z.string() });

/** The list, as the server holds it. Only the ops in `./ops.server` write it. */
export const todos = data({ label: "todo.list", initial: [] as Todo[], parse: z.array(todo) });

/** Read: the server serves the list, and pushes each change; a tab reads `todoBoard.todos`. */
export const todoBoard = remoteData({ todos });

/** Ask: every change is a call, and the server is the only writer. Outcomes are output. */
export const todoApi = rpc({
  "todo.add": {
    input: z.object({ title: z.string().trim().min(1) }),
    output: z.object({ id: z.string() }),
  },
  "todo.toggle": {
    input: z.object({ id: z.string() }),
    output: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("toggled"), done: z.boolean() }),
      gone,
    ]),
  },
  "todo.remove": {
    input: z.object({ id: z.string() }),
    output: z.discriminatedUnion("kind", [z.object({ kind: z.literal("removed") }), gone]),
  },
});
