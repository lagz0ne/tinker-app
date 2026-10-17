import { operation } from "@tinker/core";

import { drizzleOrm } from "~/components/database/index.server";
import { transaction } from "~/components/database/index.server";
import { readExecution } from "~/components/sync";
import { eventHistory, execution } from "~/components/sync/index.server";

import { raise } from "@/demo/errors";

import { counter } from "./sync.schema.server";

export const incrementCounter = operation({
  label: "incrementCounter",
  input: readExecution,
  depends: { orm: drizzleOrm, tx: transaction, history: eventHistory },
  run: async ({ orm, tx, history }, { input }) => {
    const { eq, sql } = orm;

    await history.lock(tx, "public");
    if (await history.find(tx, input.executionId, "public")) {
      return { executionId: input.executionId };
    }

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

    return { executionId: input.executionId };
  },
});
