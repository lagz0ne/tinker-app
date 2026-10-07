import { operation } from "@tinker/core";
import { database } from "./database";
import { eventHistory } from "@tinker/start/server";
import { readExecution } from "../contracts/sync";
import { raise } from "../errors";
export const incrementCounter = operation({
  label: "incrementCounter",
  input: readExecution,
  depends: { database, history: eventHistory },
  run: async ({ database, history }, { input }) => {
    const [{ eq, sql }, { counter }, { execution }] = await Promise.all([
      import("drizzle-orm"),
      import("./sync.schema"),
      import("@tinker/start/server"),
    ]);
    await database.transaction(async (tx) => {
      await history.lock(tx, "public");
      if (await history.find(tx, input.executionId, "public")) return;
      await tx.insert(execution).values({ id: input.executionId, stream: "public" });
      await tx.insert(counter).values({ id: 1 }).onConflictDoNothing();
      const row = (
        await tx
          .update(counter)
          .set({ value: sql`${counter.value} + 1` })
          .where(eq(counter.id, 1))
          .returning()
      ).at(0);
      if (!row) raise("StreamMissing", {});
      await history.append(tx, "public", input.executionId, [
        { kind: "change", change: { kind: "counter", value: row.value } },
        { kind: "result", result: { kind: "complete", action: "counter" } },
      ]);
    });
    return { executionId: input.executionId };
  },
});
