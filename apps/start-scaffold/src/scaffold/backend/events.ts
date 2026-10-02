import { resource } from "@tinker/core";
import type { Database } from "../../backend/database.ts";
import type { Sync } from "../../contracts/sync.ts";
import { raise } from "../../errors.ts";
/** A stream row stays locked until its records and events commit together. */
export const eventHistory = resource({
  label: "sync.history",
  factory: async () => {
    const [{ eq, sql }, { stream, event, execution }] = await Promise.all([
      import("drizzle-orm"),
      import("../../backend/sync.schema.ts"),
    ]);
    return {
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
          if (payload.kind === "result")
            await tx
              .update(execution)
              .set({ result: payload.result })
              .where(eq(execution.id, executionId));
        }
      },
    };
  },
});
