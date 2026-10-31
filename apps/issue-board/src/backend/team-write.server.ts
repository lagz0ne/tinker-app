import { operation } from "@tinker/core";
import { z } from "zod";

import { user } from "~/components/auth/index.server";
import { transaction, drizzleOrm } from "~/components/database/index.server";
import { mailOutbox } from "~/components/mail/index.server";
import type { Sync } from "~/components/sync";
import { eventHistory, execution } from "~/components/sync/index.server";

import { rowChange } from "@/demo/contracts/sync";
import type { Errors } from "@/demo/errors";

import { team, teamMember } from "./board.schema.server";

export const executionSeen = operation({
  label: "execution.seen",
  input: z.object({ executionId: z.string(), owner: z.string() }),
  depends: { tx: transaction, history: eventHistory },
  run: async ({ tx, history }, { input }) =>
    !!(await history.find(tx, input.executionId, input.owner)),
});

/** One lock protocol for issue, comment, and outside-server writes. */
export const lockTeamWrite = operation({
  label: "team.lock",
  input: z.object({
    teamId: z.string(),
    actorId: z.string(),
    executionId: z.string().optional(),
    assigneeId: z.string().nullable().optional(),
  }),
  depends: {
    tx: transaction,
    orm: drizzleOrm,
    history: eventHistory,
    seen: executionSeen.controller,
  },
  run: async ({ tx, orm, history, seen }, { input, raise: coreRaise }) => {
    const raise: Errors.Raise = coreRaise;

    const { eq, sql } = orm;
    const members = await tx
      .select({ id: teamMember.userId, email: user.email })
      .from(teamMember)
      .innerJoin(user, eq(user.id, teamMember.userId))
      .where(eq(teamMember.teamId, input.teamId))
      .orderBy(sql`${teamMember.userId} collate "C"`);
    if (!members.some((member) => member.id === input.actorId)) {
      return raise("NotTeamMember", {});
    }
    for (const member of members) await history.lock(tx, member.id);
    if (input.assigneeId != null && !members.some((member) => member.id === input.assigneeId)) {
      return raise("InvalidAssignee", {});
    }

    if (
      input.executionId &&
      (await seen.run({ input: { executionId: input.executionId, owner: input.actorId } }))
    ) {
      return { members, seen: true as const };
    }
    // Every membership insert locks a current member stream. A future removal
    // path must refuse a shrinking set; actor checks above use the pre-lock list.
    const current = await tx
      .select({ id: teamMember.userId })
      .from(teamMember)
      .where(eq(teamMember.teamId, input.teamId));
    if (current.some((member) => !members.some((locked) => locked.id === member.id))) {
      return raise("TeamChanged", {});
    }
    const [locked] = await tx
      .select()
      .from(team)
      .where(eq(team.id, input.teamId))
      .for("no key update");
    return { members, seen: false as const, teamKey: locked!.key };
  },
});

export const queueAlerts = operation({
  label: "alerts.queue",
  input: z.object({
    teamId: z.string(),
    actorId: z.string(),
    executionId: z.string(),
    subject: z.string(),
    text: z.string(),
  }),
  depends: { tx: transaction, orm: drizzleOrm },
  run: async ({ tx, orm }, { input }) => {
    const { sql } = orm;
    await tx.execute(sql`
      INSERT INTO ${mailOutbox} ("to", subject, text, dedupe_key)
      SELECT ${user.email}, ${input.subject}, ${input.text},
        ${input.executionId} || ':' || ${user.id}
      FROM ${teamMember} INNER JOIN ${user} ON ${teamMember.userId} = ${user.id}
      WHERE ${teamMember.teamId} = ${input.teamId} AND ${user.id} <> ${input.actorId}
      ON CONFLICT (dedupe_key) DO NOTHING
    `);
  },
});

export const fanOut = operation({
  label: "streams.fanOut",
  input: z.object({
    executionId: z.string(),
    owner: z.string(),
    deliveries: z
      .array(z.object({ stream: z.string(), payloads: z.array(z.unknown()).min(1) }))
      .min(1),
  }),
  depends: { tx: transaction, history: eventHistory },
  run: async ({ tx, history }, { input }) => {
    await tx.insert(execution).values({ id: input.executionId, stream: input.owner });
    for (const delivery of input.deliveries) {
      await history.append(
        tx,
        delivery.stream,
        input.executionId,
        delivery.payloads as Sync.Payload[],
      );
    }
  },
});

/** The same change to every locked stream; only the actor's stream also gets its result. */
export const rowDeliveries = operation({
  label: "streams.rowDeliveries",
  input: z.object({
    members: z.array(z.object({ id: z.string() })),
    change: rowChange,
    actorId: z.string(),
  }),
  run: (_deps, { input }) =>
    input.members.map((member) => ({
      stream: member.id,
      payloads: [
        { kind: "change" as const, change: input.change },
        ...(member.id === input.actorId
          ? [
              {
                kind: "result" as const,
                result: {
                  kind: "complete" as const,
                  action:
                    input.change.kind === "comment.add" ? ("comment" as const) : ("issue" as const),
                },
              },
            ]
          : []),
      ],
    })),
});
