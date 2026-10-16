import { operation } from "@tinker/core";

import { user } from "~/components/auth/index.server";
import { database, drizzleOrm } from "~/components/database/index.server";
import { eventHistory, execution } from "~/components/sync/index.server";

import { teamInput } from "@/contracts/board";
import { issueCommand } from "@/contracts/issues";
import { currentUser } from "@/demo/backend/auth.server";
import { raise } from "@/demo/errors";

import { issue, issueFields, team, teamMember } from "./board.schema.server";
import { fractionalIndex } from "./modules";
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
  depends: { database, orm: drizzleOrm, currentUser, history: eventHistory, fractionalIndex },
  run: async (
    { database, orm, currentUser, history, fractionalIndex },
    { input, random, clock },
  ) => {
    const { eq, and, asc, sql, ne } = orm;
    const { generateKeyBetween } = fractionalIndex;
    const change = input.change;

    await database.transaction(async (tx) => {
      const members = await tx
        .select({ id: teamMember.userId })
        .from(teamMember)
        .where(eq(teamMember.teamId, change.teamId))
        .orderBy(sql`${teamMember.userId} collate "C"`)
        .then(async (members) => {
          if (!members.some((member) => member.id === currentUser.id)) raise("NotTeamMember", {});
          for (const member of members) await history.lock(tx, member.id);

          if ((change.kind === "create" || change.kind === "edit") && change.assigneeId !== null) {
            if (!members.some((member) => member.id === change.assigneeId)) {
              raise("InvalidAssignee", {});
            }
          }
          return members;
        });
      if (await history.find(tx, input.executionId, currentUser.id)) return;

      // Every membership insert must lock a current member stream; otherwise this join guard is unsafe.
      // A future removal path must also refuse a member set that shrinks.
      await tx
        .select({ id: teamMember.userId })
        .from(teamMember)
        .where(eq(teamMember.teamId, change.teamId))
        .then((currentMembers) => {
          if (currentMembers.some((member) => !members.some((locked) => locked.id === member.id))) {
            raise("TeamChanged", {});
          }
        });

      await tx.select().from(team).where(eq(team.id, change.teamId)).for("no key update");

      let unchangedRank: string | undefined;
      if (change.kind !== "create") {
        await tx
          .select()
          .from(issue)
          .where(and(eq(issue.id, change.id), eq(issue.teamId, change.teamId)))
          .then(([current]) => {
            if (!current) raise("IssueMissing", {});
            if (change.kind === "edit" && current.state === change.state) {
              unchangedRank = current.rank;
            }
          });
      }

      let savedId: string;
      if (change.kind === "remove") {
        const removed = await tx
          .delete(issue)
          .where(
            and(
              eq(issue.id, change.id),
              eq(issue.teamId, change.teamId),
              eq(issue.version, change.version),
            ),
          )
          .returning({ id: issue.id });
        if (!removed.length) raise("IssueConflict", {});
        savedId = change.id;
      } else {
        const placement =
          unchangedRank !== undefined
            ? Promise.resolve(unchangedRank)
            : tx
                .select({ id: issue.id, rank: issue.rank })
                .from(issue)
                .where(
                  and(
                    eq(issue.teamId, change.teamId),
                    eq(issue.state, change.state),
                    change.kind !== "create" ? ne(issue.id, change.id) : undefined,
                  ),
                )
                .orderBy(sql`${issue.rank} collate "C"`, asc(issue.id))
                .then((stateRows) => {
                  const position =
                    change.kind === "move" && change.beforeId !== null
                      ? stateRows.findIndex((row) => row.id === change.beforeId)
                      : stateRows.length;
                  if (position < 0) raise("InvalidPosition", {});

                  const lower = stateRows[position - 1] ?? { rank: null };
                  const upper = stateRows[position] ?? { rank: null };
                  if (lower.rank === upper.rank && lower.rank !== null) {
                    raise("InvalidPosition", {});
                  }
                  return generateKeyBetween(lower.rank, upper.rank);
                });
        savedId = await placement.then(async (rank) => {
          const updatedAt = new Date(clock.currentTimeMillis());

          if (change.kind === "create") {
            const [counter] = await tx
              .update(team)
              .set({ issueSeq: sql`${team.issueSeq} + 1` })
              .where(eq(team.id, change.teamId))
              .returning({ number: team.issueSeq });
            const id = random.uuid();
            await tx.insert(issue).values({
              id,
              teamId: change.teamId,
              number: counter!.number,
              title: change.title,
              description: change.description,
              state: change.state,
              priority: change.priority,
              assigneeId: change.assigneeId,
              creatorId: currentUser.id,
              rank,
              updatedAt,
            });
            return id;
          } else {
            const values =
              change.kind === "move"
                ? { state: change.state, rank, updatedAt, version: sql`${issue.version} + 1` }
                : {
                    title: change.title,
                    description: change.description,
                    state: change.state,
                    priority: change.priority,
                    assigneeId: change.assigneeId,
                    rank,
                    updatedAt,
                    version: sql`${issue.version} + 1`,
                  };
            const saved = await tx
              .update(issue)
              .set(values)
              .where(
                and(
                  eq(issue.id, change.id),
                  eq(issue.teamId, change.teamId),
                  eq(issue.version, change.version),
                ),
              )
              .returning({ id: issue.id });
            if (!saved.length) raise("IssueConflict", {});
            return change.id;
          }
        });
      }

      const delta = await tx
        .select(issueFields)
        .from(issue)
        .innerJoin(team, eq(issue.teamId, team.id))
        .where(eq(issue.id, savedId))
        .then(([saved]) =>
          change.kind === "remove"
            ? { kind: "issue.remove" as const, id: savedId }
            : { kind: "issue.upsert" as const, issue: saved! },
        );
      await tx.insert(execution).values({ id: input.executionId, stream: currentUser.id });

      const deliveries = members.map((member) => ({
        member,
        payloads: [
          { kind: "change" as const, change: delta },
          ...(member.id === currentUser.id
            ? [
                {
                  kind: "result" as const,
                  result: { kind: "complete" as const, action: "issue" as const },
                },
              ]
            : []),
        ],
      }));
      for (const { member, payloads } of deliveries) {
        await history.append(tx, member.id, input.executionId, payloads);
      }
    });

    return { executionId: input.executionId };
  },
});
