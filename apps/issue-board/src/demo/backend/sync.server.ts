import { operation } from "@tinker/core";

import { user } from "~/components/auth/index.server";
import { principal } from "~/components/auth/index.server";
import { drizzleOrm } from "~/components/database/index.server";
import { database } from "~/components/database/index.server";
import { readCursor, readPrivateCursor } from "~/components/sync";
import type { Sync } from "~/components/sync";
import { eventHistory, event } from "~/components/sync/index.server";

import { team, teamMember, issue, issueFields } from "@/backend/board.schema.server";
import { readFeatureEvents } from "@/demo/contracts/sync";
import { raise } from "@/demo/errors";

import { currentUser } from "./auth.server";
import { counter } from "./sync.schema.server";
import { todo } from "./todos.schema.server";

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
    const { asc, eq, sql } = orm;
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
      const teams = await tx
        .select({ id: team.id, key: team.key, name: team.name, role: teamMember.role })
        .from(team)
        .innerJoin(teamMember, eq(team.id, teamMember.teamId))
        .where(eq(teamMember.userId, currentUser.id))
        .orderBy(asc(team.key));

      const issues = await tx
        .select(issueFields)
        .from(issue)
        .innerJoin(team, eq(issue.teamId, team.id))
        .innerJoin(teamMember, eq(teamMember.teamId, team.id))
        .where(eq(teamMember.userId, currentUser.id))
        .orderBy(asc(team.key), sql`${issue.rank} collate "C"`, asc(issue.id));

      return { stream: currentUser.id, revision, profile, todos, teams, issues };
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
  depends: { orm: drizzleOrm, database, principal },
  run: async ({ orm, database, principal }, { input }) => {
    const { and, asc, eq, gt } = orm;
    const events = readFeatureEvents.safeParse(
      await database
        .select()
        .from(event)
        .where(and(eq(event.stream, "public"), gt(event.revision, input.after)))
        .orderBy(asc(event.revision))
        .limit(200),
    );
    if (!events.success) raise("StoredDataInvalid", {});
    return { accountId: principal?.id ?? null, events: events.data };
  },
});

export const replayPrivate = operation({
  label: "replayPrivate",
  input: readPrivateCursor,
  depends: { orm: drizzleOrm, currentUser, database },
  run: async ({ orm, currentUser, database }, { input }) => {
    const { and, asc, eq, gt } = orm;
    if (input.accountId !== currentUser.id) raise("StreamDenied", {});
    const events = readFeatureEvents.safeParse(
      await database
        .select()
        .from(event)
        .where(and(eq(event.stream, currentUser.id), gt(event.revision, input.after)))
        .orderBy(asc(event.revision))
        .limit(200),
    );
    if (!events.success) raise("StoredDataInvalid", {});
    return events.data;
  },
});
