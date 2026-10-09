import { drizzleOrm } from "@tinker/start/server";
import { user } from "./schema.server";
import { todo } from "./todos.schema.server";
import { counter } from "./sync.schema.server";
import { operation } from "@tinker/core";
import { database } from "./database.server";
import { currentUser, principal } from "./auth.server";
import { eventHistory, event } from "@tinker/start/server";
import { readCursor, readPrivateCursor, readFeatureEvents } from "../contracts/sync";
import type { Sync } from "../contracts/sync";
import { raise } from "../errors";

export const bootstrapPublic = operation({
  label: "bootstrapPublic",
  depends: { database, history: eventHistory },
  run: ({ database, history }) => {
    return database.transaction(async (tx) => {
      const revision = await history.lock(tx, "public");
      return {
        stream: "public" as const,
        revision,
        value: (await tx.select().from(counter)).at(0)?.value ?? 0,
      };
    });
  },
});

export const bootstrapPrivate = operation({
  label: "bootstrapPrivate",
  depends: { orm: drizzleOrm, currentUser, database, history: eventHistory },
  run: ({ orm, currentUser, database, history }) => {
    const { asc, eq } = orm;
    return database.transaction(async (tx) => {
      const revision = await history.lock(tx, currentUser.id);
      const profile = (
        await tx
          .select({
            id: user.id,
            name: user.name,
            email: user.email,
            emailVerified: user.emailVerified,
          })
          .from(user)
          .where(eq(user.id, currentUser.id))
      ).at(0);
      if (!profile) raise("SignInRequired", {});
      const todos = await tx
        .select({ id: todo.id, title: todo.title, done: todo.done })
        .from(todo)
        .where(eq(todo.ownerId, currentUser.id))
        .orderBy(asc(todo.id));
      return { stream: currentUser.id, revision, profile, todos };
    });
  },
});

export const bootstrap = operation({
  label: "bootstrap",
  depends: { principal, public: bootstrapPublic, private: bootstrapPrivate },
  run: async ({
    principal,
    public: publicState,
    private: privateState,
  }): Promise<Sync.Snapshot> => ({
    public: await publicState.run(),
    private: principal === null ? null : await privateState.run(),
  }),
});

const readReplayEvents = operation({
  label: "sync.readReplayEvents",
  input: readFeatureEvents,
  run: (_deps, { input }) => input,
});

export const replayPublic = operation({
  label: "replayPublic",
  input: readCursor,
  depends: { orm: drizzleOrm, database, principal, events: readReplayEvents },
  run: async ({ orm, database, principal, events }, { input }) => {
    const { and, asc, eq, gt } = orm;
    return {
      accountId: principal?.id ?? null,
      events: events.run({
        rawInput: await database
          .select()
          .from(event)
          .where(and(eq(event.stream, "public"), gt(event.revision, input.after)))
          .orderBy(asc(event.revision))
          .limit(200),
      }),
    };
  },
});

export const replayPrivate = operation({
  label: "replayPrivate",
  input: readPrivateCursor,
  depends: { orm: drizzleOrm, currentUser, database, events: readReplayEvents },
  run: async ({ orm, currentUser, database, events }, { input }) => {
    const { and, asc, eq, gt } = orm;
    if (input.accountId !== currentUser.id) raise("StreamDenied", {});
    return events.run({
      rawInput: await database
        .select()
        .from(event)
        .where(and(eq(event.stream, currentUser.id), gt(event.revision, input.after)))
        .orderBy(asc(event.revision))
        .limit(200),
    });
  },
});
