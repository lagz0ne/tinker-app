import { operation } from "@tinker/core";

import { database, drizzleOrm } from "~/components/database/index.server";
import type { Sync } from "~/components/sync";
import { eventHistory, execution } from "~/components/sync/index.server";

import { commentCommand } from "@/contracts/comments";
import { currentUser } from "@/demo/backend/auth.server";
import { raise } from "@/demo/errors";

import { comment, issue, team, teamMember } from "./board.schema.server";

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
