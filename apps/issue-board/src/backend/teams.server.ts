import { operation } from "@tinker/core";
import { z } from "zod";

import { user } from "~/components/auth/index.server";
import { database, transaction, drizzleOrm } from "~/components/database/index.server";
import type { Sync } from "~/components/sync";
import { eventHistory } from "~/components/sync/index.server";

import { teamCommand, teamInput } from "@/contracts/board";
import { currentUser } from "@/demo/backend/auth.server";
import type { Errors } from "@/demo/errors";

import { comment, issue, issueFields, team, teamMember } from "./board.schema.server";
import { executionSeen, fanOut } from "./team-write.server";

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
  run: async ({ database, orm, currentUser }, { input, raise }) => {
    const { eq, and } = orm;

    const row = (
      await database
        .select({ id: team.id, key: team.key, name: team.name, role: teamMember.role })
        .from(team)
        .innerJoin(teamMember, eq(team.id, teamMember.teamId))
        .where(and(eq(team.id, input.teamId), eq(teamMember.userId, currentUser.id)))
    ).at(0);
    if (!row) {
      return raise("NotTeamMember", {} satisfies Errors.Payload<"NotTeamMember">);
    }

    return row;
  },
});

export const authorizeTeamJoin = operation({
  label: "teams.authorizeJoin",
  input: teamCommand,
  depends: { tx: transaction, orm: drizzleOrm, currentUser },
  run: async ({ tx, orm, currentUser }, { input, raise }) => {
    if (input.change.kind !== "addMember") {
      return raise("BadInput", {
        reason: "Expected member join",
      } satisfies Errors.Payload<"BadInput">);
    }
    const { eq, and } = orm;
    const change = input.change;
    const [member] = await tx
      .select()
      .from(teamMember)
      .where(and(eq(teamMember.teamId, change.teamId), eq(teamMember.userId, currentUser.id)));
    if (!member) {
      return raise("NotTeamMember", {} satisfies Errors.Payload<"NotTeamMember">);
    }
    if (member.role !== "admin") {
      return raise("TeamAdminRequired", {} satisfies Errors.Payload<"TeamAdminRequired">);
    }

    const [target] = await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, change.email.toLowerCase()));
    if (!target) {
      return raise("UserNotFound", {} satisfies Errors.Payload<"UserNotFound">);
    }
    return target.id;
  },
});

export const saveTeam = operation({
  label: "teams.save",
  input: z.object({ command: teamCommand, targetId: z.string().optional() }),
  depends: { tx: transaction, currentUser, history: eventHistory, seen: executionSeen.controller },
  run: async ({ tx, currentUser, history, seen }, { input, random, raise }) => {
    const { command, targetId } = input;
    const change = command.change;
    const streams = [...new Set([currentUser.id, ...(targetId ? [targetId] : [])])].sort();
    for (const stream of streams) await history.lock(tx, stream);
    if (await seen.run({ input: { executionId: command.executionId, owner: currentUser.id } })) {
      return null;
    }

    if (change.kind === "create") {
      const id = random.uuid();
      const saved = await tx
        .insert(team)
        .values({ id, key: change.key, name: change.name })
        .onConflictDoNothing({ target: team.key })
        .returning();
      if (!saved.length) {
        return raise("TeamKeyTaken", {} satisfies Errors.Payload<"TeamKeyTaken">);
      }
      await tx.insert(teamMember).values({ teamId: id, userId: currentUser.id, role: "admin" });
      return { teamId: id, streams };
    }
    await tx
      .insert(teamMember)
      .values({ teamId: change.teamId, userId: targetId!, role: "member" })
      .onConflictDoNothing();
    return { teamId: change.teamId, streams };
  },
});

export const publishTeam = operation({
  label: "teams.publish",
  input: z.object({
    teamId: z.uuid(),
    targetId: z.string().optional(),
    streams: z.array(z.string()),
    executionId: z.uuid(),
  }),
  depends: { tx: transaction, orm: drizzleOrm, currentUser, publish: fanOut.controller },
  run: async ({ tx, orm, currentUser, publish }, { input }) => {
    const { eq, asc } = orm;
    const existingIssues = input.targetId
      ? await tx
          .select(issueFields)
          .from(issue)
          .innerJoin(team, eq(issue.teamId, team.id))
          .where(eq(issue.teamId, input.teamId))
      : [];
    const issueChanges = existingIssues.map((issue) => ({
      kind: "change" as const,
      change: { kind: "issue.upsert" as const, issue },
    }));

    const existingComments = input.targetId
      ? await tx
          .select({
            id: comment.id,
            issueId: comment.issueId,
            authorId: comment.authorId,
            body: comment.body,
            createdAt: comment.createdAt,
          })
          .from(comment)
          .innerJoin(issue, eq(comment.issueId, issue.id))
          .where(eq(issue.teamId, input.teamId))
          .orderBy(asc(comment.createdAt), asc(comment.id))
      : [];
    const commentChanges = existingComments.map((row) => ({
      kind: "change" as const,
      change: {
        kind: "comment.add" as const,
        comment: { ...row, createdAt: row.createdAt.toISOString() },
      },
    }));

    const deliveries: { stream: string; payloads: Sync.Payload[] }[] = [];
    for (const stream of input.streams) {
      const rows = await tx
        .select({ id: team.id, key: team.key, name: team.name, role: teamMember.role })
        .from(team)
        .innerJoin(teamMember, eq(team.id, teamMember.teamId))
        .where(eq(teamMember.userId, stream))
        .orderBy(asc(team.key));
      const payloads: Sync.Payload[] = [
        { kind: "change", change: { kind: "teams", rows } },
        ...(stream === input.targetId ? [...issueChanges, ...commentChanges] : []),
      ];
      if (stream === currentUser.id) {
        payloads.push({ kind: "result", result: { kind: "complete", action: "team" } });
      }
      deliveries.push({ stream, payloads });
    }
    await publish.run({
      input: { executionId: input.executionId, owner: currentUser.id, deliveries },
    });
  },
});

export const changeTeam = operation({
  label: "teams.change",
  input: teamCommand,
  depends: {
    currentUser,
    authorize: authorizeTeamJoin.controller,
    save: saveTeam.controller,
    publish: publishTeam.controller,
  },
  run: async ({ authorize, save, publish }, { input }) => {
    const targetId = input.change.kind === "addMember" ? await authorize.run({ input }) : undefined;
    const saved = await save.run({ input: { command: input, targetId } });
    if (saved) await publish.run({ input: { ...saved, targetId, executionId: input.executionId } });
    return { executionId: input.executionId };
  },
});
