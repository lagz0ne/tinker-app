import { operation } from "@tinker/core";
import { z } from "zod";

import { transaction } from "~/components/database-sqlite/index.server";
import { accountNotice } from "~/components/sync-sqlite/notice";

/** Auth invokes this only after the session delete commits. */
export const publishAccountNotice = operation({
  label: "sync.accountNotice",
  input: z.strictObject({ accountId: z.string() }).brand<"AccountNotice">(),
  depends: { transaction, notice: accountNotice },
  run: async ({ transaction, notice }, { input }) => {
    // The notify row rides in this call's transaction, so its commit is what wakes listeners.
    await transaction.notify("start_sync", notice.run({ input: input.accountId }));
  },
});
