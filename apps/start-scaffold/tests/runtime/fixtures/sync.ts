import { preset } from "@tinker/core/testing";

import { accountNotice } from "~/components/sync/notice";

import { database, syncTemplate } from "./app.server";

export function handWoken(logQuery?: (query: string) => void) {
  const wakes: ((payload: string) => void)[] = [];
  const db = preset(database, async (_deps, { defer }) => {
    const { drizzle } = await import("drizzle-orm/pglite");
    const client = await syncTemplate.clone();
    defer(() => client.close());
    return Object.assign(drizzle({ client, logger: logQuery ? { logQuery } : undefined }), {
      listen: async (wake: (payload: string) => void) => {
        wakes.push(wake);
        return () => undefined;
      },
    });
  });
  return {
    db,
    emit: (payload: string) => wakes.forEach((wake) => wake(payload)),
    wake: () => wakes.forEach((wake) => wake("sync_event")),
    /** The notice an auth path sends on the sync channel, for one account. */
    notice: (accountId: string) => wakes.forEach((wake) => wake(accountNotice(accountId))),
  };
}
