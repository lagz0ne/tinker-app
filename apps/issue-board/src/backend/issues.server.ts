import { operation } from "@tinker/core";

import { user } from "~/components/auth/index.server";
import { database, transaction, drizzleOrm } from "~/components/database/index.server";

import { teamInput } from "@/contracts/board";
import { issueCommand, type Issue } from "@/contracts/issues";
import { currentUser } from "@/demo/backend/auth.server";
import { raise } from "@/demo/errors";

import { issue, issueRowFields, team, teamMember } from "./board.schema.server";
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

import { lockTeamWrite, queueAlerts, fanOut, rowDeliveries } from "./team-write.server";

export const saveIssue = operation({
  label: "issues.save",
  input: issueCommand,
  depends: { tx: transaction, orm: drizzleOrm, currentUser, fractionalIndex },
  run: async ({ tx, orm, currentUser, fractionalIndex }, { input, random, clock }) => {
    const { eq, and, asc, sql, ne } = orm;
    const { generateKeyBetween } = fractionalIndex;
    const change = input.change;
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

    let savedRow: Omit<Issue, "teamKey">;
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
        .returning(issueRowFields);
      if (!removed.length) raise("IssueConflict", {});
      savedRow = removed[0]!;
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
      savedRow = await placement.then(async (rank) => {
        const updatedAt = new Date(clock.currentTimeMillis());

        if (change.kind === "create") {
          const [counter] = await tx
            .update(team)
            .set({ issueSeq: sql`${team.issueSeq} + 1` })
            .where(eq(team.id, change.teamId))
            .returning({ number: team.issueSeq });
          const id = random.uuid();
          const [created] = await tx
            .insert(issue)
            .values({
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
            })
            .returning(issueRowFields);
          return created!;
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
            .returning(issueRowFields);
          if (!saved.length) raise("IssueConflict", {});
          return saved[0]!;
        }
      });
    }

    return savedRow;
  },
});

export const issueDelta = operation({
  label: "issues.delta",
  input: (raw: unknown) =>
    raw as { row: Omit<Issue, "teamKey">; teamKey: string; removed: boolean },
  run: async (_deps, { input }) => {
    const saved = { ...input.row, teamKey: input.teamKey };
    return input.removed
      ? { delta: { kind: "issue.remove" as const, id: saved.id }, subject: "An issue was removed" }
      : {
          delta: { kind: "issue.upsert" as const, issue: saved },
          subject: `${saved.teamKey}-${saved.number}: ${saved.title}`,
        };
  },
});

export const changeIssue = operation({
  label: "issues.change",
  input: issueCommand,
  depends: {
    currentUser,
    lock: lockTeamWrite.controller,
    save: saveIssue.controller,
    delta: issueDelta.controller,
    alerts: queueAlerts.controller,
    publish: fanOut.controller,
  },
  run: async ({ currentUser, lock, save, delta, alerts, publish }, { input }) => {
    const change = input.change;
    const locked = await lock.run({
      input: {
        teamId: change.teamId,
        actorId: currentUser.id,
        executionId: input.executionId,
        assigneeId:
          change.kind === "create" || change.kind === "edit" ? change.assigneeId : undefined,
      },
    });
    if (locked.seen) return { executionId: input.executionId };

    const row = await save.run({ input });
    const saved = await delta.run({
      input: { row, teamKey: locked.teamKey, removed: change.kind === "remove" },
    });
    await alerts.run({
      input: {
        teamId: change.teamId,
        actorId: currentUser.id,
        executionId: input.executionId,
        subject: saved.subject,
        text: `${currentUser.name}: issue ${change.kind}.`,
      },
    });
    await publish.run({
      input: {
        executionId: input.executionId,
        owner: currentUser.id,
        deliveries: rowDeliveries(locked.members, saved.delta, currentUser.id),
      },
    });
    return { executionId: input.executionId };
  },
});
