import { operation } from "@tinker/core";
import { database } from "./database.ts";
import { eventHistory } from "../scaffold/backend/events.ts";
import { readExecution } from "../contracts/sync.ts";
import { raise } from "../errors.ts";
export const incrementCounter = operation({
  label: "incrementCounter",
  input: readExecution,
  depends: { database, history: eventHistory },
  run: async ({ database, history }, ctx) => {
    const [{ eq, sql }, { counter }, { execution }] = await Promise.all([
      import("drizzle-orm"),
      import("./sync.schema.ts"),
      import("../scaffold/backend/sync.schema.ts"),
    ]);
    await database.transaction(async (tx) => {
      await history.lock(tx, "public");
      if (await history.find(tx, ctx.input.executionId, "public")) return;
      await tx.insert(execution).values({ id: ctx.input.executionId, stream: "public" });
      await tx.insert(counter).values({ id: 1 }).onConflictDoNothing();
      const row = (
        await tx
          .update(counter)
          .set({ value: sql`${counter.value} + 1` })
          .where(eq(counter.id, 1))
          .returning()
      ).at(0);
      if (!row) raise("StreamMissing", {});
      await history.append(tx, "public", ctx.input.executionId, [
        { kind: "change", change: { kind: "counter", value: row.value } },
        { kind: "result", result: { kind: "complete", action: "counter" } },
      ]);
    });
    return { executionId: ctx.input.executionId };
  },
});
