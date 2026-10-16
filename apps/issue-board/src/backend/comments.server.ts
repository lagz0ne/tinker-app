import { operation } from "@tinker/core";

import { user } from "~/components/auth/index.server";
import { database, drizzleOrm } from "~/components/database/index.server";
import type { Sync } from "~/components/sync";
import { eventHistory, execution } from "~/components/sync/index.server";

import { commentCommand } from "@/contracts/comments";
import { currentUser } from "@/demo/backend/auth.server";
import { raise } from "@/demo/errors";

import { comment, issue, team, teamMember, mailOutbox } from "./board.schema.server";

export const addComment = operation({
  label: "comments.add",
  input: commentCommand,
  depends: { database, orm: drizzleOrm, currentUser, history: eventHistory },
  run: async ({ database, orm, currentUser, history }, { input, random, clock }) => {
    const { eq, and, sql } = orm;
    const draft = input.comment;

    await database.transaction(async (tx) => {
      const members = await tx
        .select({ id: teamMember.userId })
        .from(teamMember)
        .where(eq(teamMember.teamId, draft.teamId))
        .orderBy(sql`${teamMember.userId} collate "C"`);
      if (!members.some((member) => member.id === currentUser.id)) raise("NotTeamMember", {});
      for (const member of members) await history.lock(tx, member.id);

      if (await history.find(tx, input.executionId, currentUser.id)) return;

      // Joins must lock a current member stream before changing membership.
      // A future removal path must also reject a shrunk member set.
      const currentMembers = await tx
        .select({ id: teamMember.userId })
        .from(teamMember)
        .where(eq(teamMember.teamId, draft.teamId));
      if (currentMembers.some((member) => !members.some((locked) => locked.id === member.id))) {
        raise("TeamChanged", {});
      }

      await tx.select().from(team).where(eq(team.id, draft.teamId)).for("no key update");

      const [target] = await tx
        .select({ id: issue.id })
        .from(issue)
        .where(and(eq(issue.id, draft.issueId), eq(issue.teamId, draft.teamId)));
      if (!target) raise("IssueMissing", {});

      const [saved] = await tx
        .insert(comment)
        .values({
          id: random.uuid(),
          issueId: target.id,
          authorId: currentUser.id,
          body: draft.body,
          createdAt: new Date(clock.currentTimeMillis()),
        })
        .returning();
      const added = { ...saved!, createdAt: saved!.createdAt.toISOString() };

      const [label] = await tx
        .select({ key: team.key, number: issue.number })
        .from(issue)
        .innerJoin(team, eq(issue.teamId, team.id))
        .where(eq(issue.id, target.id));
      await tx.execute(sql`
        INSERT INTO ${mailOutbox} ("to", subject, text, dedupe_key)
        SELECT ${user.email}, ${`New comment on ${label!.key}-${label!.number}`},
          ${`${currentUser.name} commented:\n\n${draft.body}`},
          ${input.executionId} || ':' || ${user.id}
        FROM ${teamMember} INNER JOIN ${user} ON ${teamMember.userId} = ${user.id}
        WHERE ${teamMember.teamId} = ${draft.teamId} AND ${user.id} <> ${currentUser.id}
        ON CONFLICT (dedupe_key) DO NOTHING
      `);

      await tx.insert(execution).values({ id: input.executionId, stream: currentUser.id });

      for (const member of members) {
        const payloads: Sync.Payload[] = [
          { kind: "change", change: { kind: "comment.add", comment: added } },
        ];
        if (member.id === currentUser.id) {
          payloads.push({ kind: "result", result: { kind: "complete", action: "comment" } });
        }
        await history.append(tx, member.id, input.executionId, payloads);
      }
    });

    return { executionId: input.executionId };
  },
});
