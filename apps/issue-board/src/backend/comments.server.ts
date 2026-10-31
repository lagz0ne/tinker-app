import { operation } from "@tinker/core";
import { z } from "zod";

import { transaction, drizzleOrm } from "~/components/database/index.server";

import { commentCommand } from "@/contracts/comments";
import { currentUser } from "@/demo/backend/auth.server";
import type { Errors } from "@/demo/errors";

import { comment, issue } from "./board.schema.server";
import { lockTeamWrite, queueAlerts, fanOut, rowDeliveries } from "./team-write.server";

export const saveComment = operation({
  label: "comments.save",
  input: z.object({ command: commentCommand, teamKey: z.string() }),
  depends: { tx: transaction, orm: drizzleOrm, currentUser },
  run: async ({ tx, orm, currentUser }, { input, random, clock, raise: coreRaise }) => {
    const raise: Errors.Raise = coreRaise;

    const { eq, and } = orm;
    const draft = input.command.comment;
    const [target] = await tx
      .select({ id: issue.id, number: issue.number })
      .from(issue)
      .where(and(eq(issue.id, draft.issueId), eq(issue.teamId, draft.teamId)));
    if (!target) {
      return raise("IssueMissing", {});
    }

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

    return { added, label: { key: input.teamKey, number: target.number } };
  },
});

export const addComment = operation({
  label: "comments.add",
  input: commentCommand,
  depends: {
    currentUser,
    lock: lockTeamWrite.controller,
    save: saveComment.controller,
    alerts: queueAlerts.controller,
    fanDeliveries: rowDeliveries.controller,
    publish: fanOut.controller,
  },
  run: async ({ currentUser, lock, save, alerts, fanDeliveries, publish }, { input }) => {
    const locked = await lock.run({
      input: {
        teamId: input.comment.teamId,
        actorId: currentUser.id,
        executionId: input.executionId,
      },
    });
    if (locked.seen) return { executionId: input.executionId };
    const saved = await save.run({ input: { command: input, teamKey: locked.teamKey } });

    await alerts.run({
      input: {
        teamId: input.comment.teamId,
        actorId: currentUser.id,
        executionId: input.executionId,
        subject: `New comment on ${saved.label.key}-${saved.label.number}`,
        text: `${currentUser.name} commented:\n\n${input.comment.body}`,
      },
    });
    await publish.run({
      input: {
        executionId: input.executionId,
        owner: currentUser.id,
        deliveries: fanDeliveries.run({
          input: {
            members: locked.members,
            change: { kind: "comment.add", comment: saved.added },
            actorId: currentUser.id,
          },
        }),
      },
    });
    return { executionId: input.executionId };
  },
});
