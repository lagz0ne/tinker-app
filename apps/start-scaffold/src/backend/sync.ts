import { operation } from "@tinker/core";
import { database } from "./database.ts";
import { currentUser, principal } from "./auth.ts";
import { eventHistory } from "../scaffold/backend/events.ts";
import { readCursor, readPrivateCursor, readFeatureEvent } from "../contracts/sync.ts";
import type { Sync } from "../contracts/sync.ts";
import { raise } from "../errors.ts";
export const bootstrapPublic = operation({
  label: "bootstrapPublic",
  depends: { database, history: eventHistory },
  run: async ({ database, history }) => {
    const { counter } = await import("./sync.schema.ts");
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
  depends: { currentUser, database, history: eventHistory },
  run: async ({ currentUser, database, history }) => {
    const [{ eq, asc }, { user }, { todo }] = await Promise.all([
      import("drizzle-orm"),
      import("./schema.ts"),
      import("./todos.schema.ts"),
    ]);
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
export const replayPublic = operation({
  label: "replayPublic",
  input: readCursor,
  depends: { database, principal },
  run: async ({ database, principal }, ctx) => {
    const [{ and, eq, gt, asc }, { event }] = await Promise.all([
      import("drizzle-orm"),
      import("../scaffold/backend/sync.schema.ts"),
    ]);
    return {
      accountId: principal?.id ?? null,
      events: (
        await database
          .select()
          .from(event)
          .where(and(eq(event.stream, "public"), gt(event.revision, ctx.input.after)))
          .orderBy(asc(event.revision))
          .limit(200)
      ).map(readFeatureEvent),
    };
  },
});
export const replayPrivate = operation({
  label: "replayPrivate",
  input: readPrivateCursor,
  depends: { currentUser, database },
  run: async ({ currentUser, database }, ctx) => {
    if (ctx.input.accountId !== currentUser.id) raise("StreamDenied", {});
    const [{ and, eq, gt, asc }, { event }] = await Promise.all([
      import("drizzle-orm"),
      import("../scaffold/backend/sync.schema.ts"),
    ]);
    return (
      await database
        .select()
        .from(event)
        .where(and(eq(event.stream, currentUser.id), gt(event.revision, ctx.input.after)))
        .orderBy(asc(event.revision))
        .limit(200)
    ).map(readFeatureEvent);
  },
});
