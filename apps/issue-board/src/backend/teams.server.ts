import { operation } from "@tinker/core";

import { user } from "~/components/auth/index.server";
import { database, drizzleOrm } from "~/components/database/index.server";
import type { Sync } from "~/components/sync";
import { eventHistory, execution } from "~/components/sync/index.server";

import { teamCommand, teamInput } from "@/contracts/board";
import { currentUser } from "@/demo/backend/auth.server";
import { raise } from "@/demo/errors";

import { comment, issue, issueFields, team, teamMember } from "./board.schema.server";

export const listTeams = operation({
  label: "teams.list",
  depends: { database, orm: drizzleOrm, currentUser },
  run: async ({ database, orm, currentUser }) => {
    const { eq, asc } = orm;

    return database
      .select({ id: team.id, key: team.key, name: team.name, role: teamMember.role })
      .from(team)
      .innerJoin(teamMember, eq(team.id, teamMember.teamId))
      .where(eq(teamMember.userId, currentUser.id))
      .orderBy(asc(team.key));
  },
});

export const readTeam = operation({
  label: "teams.read",
  input: teamInput,
  depends: { database, orm: drizzleOrm, currentUser },
  run: async ({ database, orm, currentUser }, { input }) => {
    const { eq, and } = orm;

    const row = (
      await database
        .select({ id: team.id, key: team.key, name: team.name, role: teamMember.role })
        .from(team)
        .innerJoin(teamMember, eq(team.id, teamMember.teamId))
        .where(and(eq(team.id, input.teamId), eq(teamMember.userId, currentUser.id)))
    ).at(0);
    if (!row) raise("NotTeamMember", {});

    return row;
  },
});

export const changeTeam = operation({
  label: "teams.change",
  input: teamCommand,
  depends: { database, orm: drizzleOrm, currentUser, history: eventHistory },
  run: async ({ database, orm, currentUser, history }, { input, random }) => {
    const { eq, and, asc } = orm;
    const change = input.change;

    if (change.kind === "create") {
      await database.transaction(async (tx) => {
        await history.lock(tx, currentUser.id);
        if (await history.find(tx, input.executionId, currentUser.id)) return;

        const id = random.uuid();
        const saved = await tx
          .insert(team)
          .values({ id, key: change.key, name: change.name })
          .onConflictDoNothing({ target: team.key })
          .returning();
        if (saved.length === 0) raise("TeamKeyTaken", {});
        await tx.insert(teamMember).values({ teamId: id, userId: currentUser.id, role: "admin" });

        const rows = await tx
          .select({ id: team.id, key: team.key, name: team.name, role: teamMember.role })
          .from(team)
          .innerJoin(teamMember, eq(team.id, teamMember.teamId))
          .where(eq(teamMember.userId, currentUser.id))
          .orderBy(asc(team.key));
        await tx.insert(execution).values({ id: input.executionId, stream: currentUser.id });
        await history.append(tx, currentUser.id, input.executionId, [
          { kind: "change", change: { kind: "teams", rows } },
          { kind: "result", result: { kind: "complete", action: "team" } },
        ]);
      });
    } else {
      await database.transaction(async (tx) => {
        const member = (
          await tx
            .select()
            .from(teamMember)
            .where(and(eq(teamMember.teamId, change.teamId), eq(teamMember.userId, currentUser.id)))
        ).at(0);
        if (!member) raise("NotTeamMember", {});
        if (member.role !== "admin") raise("TeamAdminRequired", {});

        const target = await tx
          .select({ id: user.id })
          .from(user)
          .where(eq(user.email, change.email.toLowerCase()))
          .then(([target]) => {
            if (!target) raise("UserNotFound", {});
            return target;
          });

        const streams = [...new Set([currentUser.id, target.id])].sort();
        for (const stream of streams) await history.lock(tx, stream);
        if (await history.find(tx, input.executionId, currentUser.id)) return;

        await tx
          .insert(teamMember)
          .values({ teamId: change.teamId, userId: target.id, role: "member" })
          .onConflictDoNothing();
        await tx.insert(execution).values({ id: input.executionId, stream: currentUser.id });

        const existingIssues = await tx
          .select(issueFields)
          .from(issue)
          .innerJoin(team, eq(issue.teamId, team.id))
          .where(eq(issue.teamId, change.teamId));
        const issueChanges = existingIssues.map((issue) => ({
          kind: "change" as const,
          change: { kind: "issue.upsert" as const, issue },
        }));

        const existingComments = await tx
          .select({
            id: comment.id,
            issueId: comment.issueId,
            authorId: comment.authorId,
            body: comment.body,
            createdAt: comment.createdAt,
          })
          .from(comment)
          .innerJoin(issue, eq(comment.issueId, issue.id))
          .where(eq(issue.teamId, change.teamId));
        const commentChanges = existingComments.map((row) => ({
          kind: "change" as const,
          change: {
            kind: "comment.add" as const,
            comment: { ...row, createdAt: row.createdAt.toISOString() },
          },
        }));

        for (const stream of streams) {
          const rows = await tx
            .select({ id: team.id, key: team.key, name: team.name, role: teamMember.role })
            .from(team)
            .innerJoin(teamMember, eq(team.id, teamMember.teamId))
            .where(eq(teamMember.userId, stream))
            .orderBy(asc(team.key));
          const payloads: Sync.Payload[] = [
            { kind: "change", change: { kind: "teams", rows } },
            ...(stream === target.id ? [...issueChanges, ...commentChanges] : []),
          ];
          if (stream === currentUser.id) {
            payloads.push({ kind: "result", result: { kind: "complete", action: "team" } });
          }
          await history.append(tx, stream, input.executionId, payloads);
        }
      });
    }

    return { executionId: input.executionId };
  },
});
