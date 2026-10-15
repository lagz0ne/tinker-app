import { operation } from "@tinker/core";
import { z } from "zod";

import { database, drizzleOrm } from "~/components/database/index.server";
import { accountNotice } from "~/components/sync/notice";

/** Auth invokes this only after the session delete commits. */
export const publishAccountNotice = operation({
  label: "sync.accountNotice",
  input: z.strictObject({ accountId: z.string() }).brand<"AccountNotice">(),
  depends: { database, orm: drizzleOrm },
  run: async ({ database, orm }, { input }) => {
    await database.execute(
      orm.sql`select pg_notify('start_sync', ${accountNotice(input.accountId)})`,
    );
  },
});
