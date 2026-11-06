import { operation, resource, tag } from "@tinker/core";
import { z } from "zod";

import { step } from "~/components/protocol";
import { routes } from "~/components/requests/index.server";
import { channel } from "~/components/rpc";

import { activity, people, todos } from "./contracts";
import type { Event } from "./contracts";

// The server's operations. The board serves the shared cells; only these ops write them.

/** The caller. Only the signedIn middleware binds it. */
export const user = tag<string>({ label: "user" });

/** One per request session: the cookie `sid=<name>` to a user, or null. */
const principal = resource({
  label: "principal",
  target: "session",
  depends: { req: routes.request.required },
  factory: ({ req }) => /(?:^|; )sid=(\w+)/.exec(req.headers.get("cookie") ?? "")?.[1] ?? null,
});

export const signedIn = operation({
  label: "signedIn",
  input: step,
  depends: { who: principal },
  // No user: refuse, a value. The call answers the `refused` fault; nothing is thrown here.
  run: async ({ who }, { input }) =>
    who ? input.next({ tags: [user(who)] }) : input.refuse({ signIn: true }),
});

const note = (
  log: { get(): Event[]; set(v: Event[]): void },
  who: string,
  what: string,
  at: Date,
) => log.set([{ who, what, at }, ...log.get()].slice(0, 20));

export const addTodo = operation({
  label: "todo.add.do",
  input: z.object({ title: z.string() }),
  depends: { list: todos.controller, log: activity.controller, me: user.required },
  run: ({ list, log, me }, { input, random, clock }) => {
    const at = new Date(clock.currentTimeMillis());
    const id = random.uuid();
    list.set([...list.get(), { id, title: input.title, done: false, by: me, at }]);
    note(log, me, `added "${input.title}"`, at);
    return { id };
  },
});

export const toggleTodo = operation({
  label: "todo.toggle.do",
  input: z.object({ id: z.string() }),
  depends: { list: todos.controller, log: activity.controller, me: user.required },
  run: ({ list, log, me }, { input, clock }) => {
    const item = list.get().find((t) => t.id === input.id);
    if (!item) return { kind: "gone" as const, id: input.id };
    list.set(list.get().map((t) => (t.id === input.id ? { ...t, done: !t.done } : t)));
    note(
      log,
      me,
      `${item.done ? "reopened" : "finished"} "${item.title}"`,
      new Date(clock.currentTimeMillis()),
    );
    return { kind: "toggled" as const, done: !item.done };
  },
});

export const removeTodo = operation({
  label: "todo.remove.do",
  input: z.object({ id: z.string() }),
  depends: { list: todos.controller, log: activity.controller, me: user.required },
  run: ({ list, log, me }, { input, clock }) => {
    const item = list.get().find((t) => t.id === input.id);
    if (!item) return { kind: "gone" as const, id: input.id };
    list.set(list.get().filter((t) => t.id !== input.id));
    note(log, me, `removed "${item.title}"`, new Date(clock.currentTimeMillis()));
    return { kind: "removed" as const };
  },
});

/** Open streams per user, one per server root. */
const streams = resource({
  label: "presence.streams",
  target: "scope",
  factory: () => new Map<string, number>(),
});

/** Counts the user online while the stream is open; one user with two tabs stays until both close. */
export const joinPresence = operation({
  label: "presence.join.do",
  input: z.null(),
  depends: { online: people.controller, me: user.required, open: streams, out: channel.required },
  run: async ({ online, me, open, out }) => {
    open.set(me, (open.get(me) ?? 0) + 1);
    if (!online.get().includes(me)) online.set([...online.get(), me].sort());
    try {
      out.send(online.get().length);
      await new Promise<void>((done) =>
        out.closed.aborted
          ? done()
          : out.closed.addEventListener("abort", () => done(), { once: true }),
      );
    } finally {
      const left = (open.get(me) ?? 1) - 1;
      if (left > 0) open.set(me, left);
      else {
        open.delete(me);
        online.set(online.get().filter((p) => p !== me));
      }
    }
  },
});
