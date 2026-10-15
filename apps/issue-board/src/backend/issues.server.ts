import { operation } from "@tinker/core";

import { user } from "~/components/auth/index.server";
import { database, drizzleOrm } from "~/components/database/index.server";
import { eventHistory, execution } from "~/components/sync/index.server";

import { teamInput } from "@/contracts/board";
import { issueCommand } from "@/contracts/issues";
import { currentUser } from "@/demo/backend/auth.server";
import { raise } from "@/demo/errors";

import { issue, issueFields, team, teamMember } from "./board.schema.server";
import { readTeam } from "./teams.server";

export const listTeamMembers = operation({
  label: "teams.members",
  input: teamInput,
  depends: { database, orm: drizzleOrm, access: readTeam.controller },
  run: async ({ database, orm, access }, { input }) => {
    await access.run({ input });
    const { eq, asc } = orm;

    return database
      .select({ id: user.id, name: user.name })
      .from(teamMember)
      .innerJoin(user, eq(teamMember.userId, user.id))
      .where(eq(teamMember.teamId, input.teamId))
      .orderBy(asc(user.name), asc(user.id));
  },
});

export const changeIssue = operation({
  label: "issues.change",
  input: issueCommand,
  depends: { database, orm: drizzleOrm, currentUser, history: eventHistory },
  run: async ({ database, orm, currentUser, history }, { input, random, clock }) => {
    const { eq, and, asc, sql } = orm;
    const change = input.change;

    await database.transaction(async (tx) => {
      const member = (
        await tx
          .select()
          .from(teamMember)
          .where(and(eq(teamMember.teamId, change.teamId), eq(teamMember.userId, currentUser.id)))
      ).at(0);
      if (!member) raise("NotTeamMember", {});

      await history.lock(tx, currentUser.id);
      if (await history.find(tx, input.executionId, currentUser.id)) return;

      if (change.assigneeId !== null) {
        const assignee = (
          await tx
            .select()
            .from(teamMember)
            .where(
              and(eq(teamMember.teamId, change.teamId), eq(teamMember.userId, change.assigneeId)),
            )
        ).at(0);
        if (!assignee) raise("InvalidAssignee", {});
      }

      const values = {
        title: change.title,
        description: change.description,
        state: change.state,
        priority: change.priority,
        assigneeId: change.assigneeId,
        updatedAt: new Date(clock.currentTimeMillis()),
      };
      if (change.kind === "create") {
        const [counter] = await tx
          .update(team)
          .set({ issueSeq: sql`${team.issueSeq} + 1` })
          .where(eq(team.id, change.teamId))
          .returning({ number: team.issueSeq });
        await tx.insert(issue).values({
          ...values,
          id: random.uuid(),
          teamId: change.teamId,
          number: counter!.number,
          creatorId: currentUser.id,
          rank: String(counter!.number).padStart(12, "0"),
        });
      } else {
        const saved = await tx
          .update(issue)
          .set(values)
          .where(and(eq(issue.id, change.id), eq(issue.teamId, change.teamId)))
          .returning({ id: issue.id });
        if (saved.length === 0) raise("IssueMissing", {});
      }

      const rows = await tx
        .select(issueFields)
        .from(issue)
        .innerJoin(team, eq(issue.teamId, team.id))
        .innerJoin(teamMember, eq(teamMember.teamId, team.id))
        .where(eq(teamMember.userId, currentUser.id))
        .orderBy(asc(team.key), asc(issue.number));
      await tx.insert(execution).values({ id: input.executionId, stream: currentUser.id });
      await history.append(tx, currentUser.id, input.executionId, [
        { kind: "change", change: { kind: "issues", rows } },
        { kind: "result", result: { kind: "complete", action: "issue" } },
      ]);
    });

    return { executionId: input.executionId };
  },
});
