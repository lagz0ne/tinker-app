import { operation, resource } from "@tinker/core";
import { z } from "zod";

import { database, drizzleOrm } from "~/components/database/index.server";
import type { Database } from "~/components/database/index.server";
import { raise } from "~/components/errors";
import type { Sync } from "~/components/sync/envelopes";
import { stream, event, execution } from "~/components/sync/schema";

/**
 * Snapshots read a cursor without a row lock. Writers keep their stream row locked
 * until its records and events commit together. The Drizzle module is a lazy dep.
 */
export const eventHistory = resource({
  label: "sync.history",
  depends: { orm: drizzleOrm },
  factory: async ({ orm }) => {
    const { eq, sql } = orm;
    return {
      async read(tx: Database.Transaction, id: string) {
        const [row] = await tx.select().from(stream).where(eq(stream.id, id));
        if (!row) raise("StreamMissing", {});
        return row.revision;
      },
      async lock(tx: Database.Transaction, id: string) {
        await tx.insert(stream).values({ id }).onConflictDoNothing();
        const row = (await tx.select().from(stream).where(eq(stream.id, id)).for("update")).at(0);
        if (!row) raise("StreamMissing", {});
        return row.revision;
      },
      async find(tx: Database.Transaction, id: string, owner: string) {
        const row = (await tx.select().from(execution).where(eq(execution.id, id))).at(0);
        if (row && row.stream !== owner) raise("StreamDenied", {});
        return row;
      },
      async append(
        tx: Database.Transaction,
        owner: string,
        executionId: string,
        payloads: Sync.Payload[],
      ) {
        const row = (
          await tx
            .update(stream)
            .set({ revision: sql`${stream.revision} + ${payloads.length}` })
            .where(eq(stream.id, owner))
            .returning()
        ).at(0);
        if (!row) raise("StreamMissing", {});
        await tx.insert(event).values(
          payloads.map((payload, offset) => ({
            stream: owner,
            revision: row.revision - payloads.length + offset + 1,
            executionId,
            payload,
          })),
        );
        for (const payload of payloads) {
          if (payload.kind === "result") {
            await tx
              .update(execution)
              .set({ result: payload.result })
              .where(eq(execution.id, executionId));
          }
        }
      },
    };
  },
});

/** Better Auth awaits this idempotent insert after its own user transaction. */
export const createAccountStream = operation({
  label: "sync.accountCreated",
  input: z.strictObject({ accountId: z.string().min(1) }),
  depends: { database },
  run: async ({ database }, { input }) => {
    await database.insert(stream).values({ id: input.accountId }).onConflictDoNothing();
  },
});
