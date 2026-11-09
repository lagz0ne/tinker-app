import { data, remoteData, rpc } from "@tinker/core";
import { z } from "zod";

// Shared by server and client: what can be read (board) and what can be asked (api).

const todo = z.object({
  id: z.string(),
  title: z.string(),
  done: z.boolean(),
  by: z.string(),
  at: z.date(),
});

const event = z.object({ who: z.string(), what: z.string(), at: z.date() });
export type Todo = z.infer<typeof todo>;
export type Event = z.infer<typeof event>;
/** A todo that is no longer there: a domain outcome, so it is part of the output shape. */
const gone = z.object({ kind: z.literal("gone"), id: z.string() });

/** Read: plain cells. Only the server's writer ops import them raw; everyone else reads `board.todos`. */
export const todos = data({ initial: [] as Todo[], parse: z.array(todo) });
export const people = data({ initial: [] as string[], parse: z.array(z.string()) }); // online now
export const activity = data({ initial: [] as Event[], parse: z.array(event) }); // the last 20 changes
export const board = remoteData({ todos, people, activity });

/** Ask: every change is a call; the server is the only writer. No error list: outcomes are output. */
export const api = rpc({
  "todo.add": {
    input: z.object({ title: z.string().min(1) }),
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
  /** Open while the client is: the server counts this user online until it ends. */
  "presence.join": { input: z.null(), output: z.number(), mode: "stream" },
});
