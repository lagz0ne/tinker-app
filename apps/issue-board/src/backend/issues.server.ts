import { operation } from "@tinker/core";
import { z } from "zod";

import { user } from "~/components/auth/index.server";
import { database, transaction, drizzleOrm } from "~/components/database/index.server";

import { teamInput } from "@/contracts/board";
import { issueCommand, issueChange, issueRecord } from "@/contracts/issues";
import { currentUser } from "@/demo/backend/auth.server";
import { raise } from "@/demo/errors";

import { issue, issueRowFields, team, teamMember } from "./board.schema.server";
import { fractionalIndex } from "./modules";
import { lockTeamWrite, queueAlerts, fanOut, rowDeliveries } from "./team-write.server";
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

export const readIssue = operation({
  label: "issues.read",
  input: issueCommand,
  depends: { tx: transaction, orm: drizzleOrm },
  run: async ({ tx, orm }, { input }) => {
    const change = input.change;

    if (change.kind === "create") return null;

    const { eq, and } = orm;

    const [current] = await tx
      .select(issueRowFields)
      .from(issue)
      .where(and(eq(issue.id, change.id), eq(issue.teamId, change.teamId)));

    if (!current) raise("IssueMissing", {});

    return current;
  },
});

export const rankIssue = operation({
  label: "issues.rank",
  input: z.object({
    rows: z.array(z.object({ id: z.uuid(), rank: z.string() })),
    beforeId: z.uuid().nullable(),
  }),
  depends: { fractionalIndex },
  run: async ({ fractionalIndex }, { input }) => {
    const { rows, beforeId } = input;

    const position = beforeId === null ? rows.length : rows.findIndex((row) => row.id === beforeId);

    if (position < 0) raise("InvalidPosition", {});

    const lower = (rows[position - 1] ?? { rank: null }).rank;

    const upper = (rows[position] ?? { rank: null }).rank;

    if (lower === upper && lower !== null) raise("InvalidPosition", {});

    return fractionalIndex.generateKeyBetween(lower, upper);
  },
});

export const placeIssue = operation({
  label: "issues.place",
  input: z.object({
    change: z.union([issueChange.options[0], issueChange.options[1], issueChange.options[2]]),
    current: issueRecord.omit({ teamKey: true }).nullable(),
  }),
  depends: { tx: transaction, orm: drizzleOrm, rank: rankIssue.controller },
  run: async ({ tx, orm, rank }, { input }) => {
    const { change, current } = input;

    if (change.kind === "edit" && current?.state === change.state) return current.rank;

    const { eq, and, ne, sql, asc } = orm;

    const rows = await tx
      .select({ id: issue.id, rank: issue.rank })
      .from(issue)
      .where(
        and(
          eq(issue.teamId, change.teamId),
          eq(issue.state, change.state),
          change.kind !== "create" ? ne(issue.id, change.id) : undefined,
        ),
      )
      .orderBy(sql`${issue.rank} collate "C"`, asc(issue.id));

    return rank.run({ input: { rows, beforeId: change.kind === "move" ? change.beforeId : null } });
  },
});

export const createIssue = operation({
  label: "issues.create",
  input: z.object({ change: issueChange.options[0], rank: z.string() }),
  depends: { tx: transaction, orm: drizzleOrm, currentUser },
  run: async ({ tx, orm, currentUser }, { input, random, clock }) => {
    const { eq, sql } = orm;

    const { change, rank } = input;

    const [counter] = await tx
      .update(team)
      .set({ issueSeq: sql`${team.issueSeq} + 1` })
      .where(eq(team.id, change.teamId))
      .returning({ number: team.issueSeq });

    const [created] = await tx
      .insert(issue)
      .values({
        id: random.uuid(),
        teamId: change.teamId,
        number: counter!.number,
        title: change.title,
        description: change.description,
        state: change.state,
        priority: change.priority,
        assigneeId: change.assigneeId,
        creatorId: currentUser.id,
        rank,
        updatedAt: new Date(clock.currentTimeMillis()),
      })
      .returning(issueRowFields);

    return created!;
  },
});

export const updateIssue = operation({
  label: "issues.update",
  input: z.object({
    change: z.union([issueChange.options[1], issueChange.options[2], issueChange.options[3]]),
    rank: z.string(),
  }),
  depends: { tx: transaction, orm: drizzleOrm },
  run: async ({ tx, orm }, { input, clock }) => {
    const { eq, and, sql } = orm;

    const { change, rank } = input;

    const guard = and(
      eq(issue.id, change.id),
      eq(issue.teamId, change.teamId),
      eq(issue.version, change.version),
    );

    if (change.kind === "remove") {
      const [removed] = await tx.delete(issue).where(guard).returning(issueRowFields);
      if (!removed) raise("IssueConflict", {});
      return removed;
    }

    const updatedAt = new Date(clock.currentTimeMillis());

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

    const [saved] = await tx.update(issue).set(values).where(guard).returning(issueRowFields);

    if (!saved) raise("IssueConflict", {});

    return saved;
  },
});

export const saveIssue = operation({
  label: "issues.save",
  input: issueCommand,
  depends: {
    read: readIssue.controller,
    place: placeIssue.controller,
    create: createIssue.controller,
    update: updateIssue.controller,
  },
  run: async ({ read, place, create, update }, { input }) => {
    const current = await read.run({ input });

    const change = input.change;

    if (change.kind === "remove") return update.run({ input: { change, rank: "" } });

    const rank = await place.run({ input: { change, current } });

    if (change.kind === "create") return create.run({ input: { change, rank } });

    return update.run({ input: { change, rank } });
  },
});

export const issueDelta = operation({
  label: "issues.delta",
  input: z.object({
    row: issueRecord.omit({ teamKey: true }),
    teamKey: z.string(),
    removed: z.boolean(),
  }),
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
    fanDeliveries: rowDeliveries.controller,
    publish: fanOut.controller,
  },
  run: async ({ currentUser, lock, save, delta, alerts, fanDeliveries, publish }, { input }) => {
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
        deliveries: fanDeliveries.run({
          input: { members: locked.members, change: saved.delta, actorId: currentUser.id },
        }),
      },
    });

    return { executionId: input.executionId };
  },
});
