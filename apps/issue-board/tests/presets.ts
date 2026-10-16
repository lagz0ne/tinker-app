import type { PGliteInterface } from "@electric-sql/pglite";
import { preset } from "@tinker/core/testing";
import { afterAll, beforeAll } from "vite-plus/test";

import { sendAuthMail, sessionDeleted, userCreated } from "~/components/auth/index.server";
import { database, leaseFrom } from "~/components/database/index.server";
import type { Database } from "~/components/database/index.server";
import { authMail } from "~/components/mail/index.server";
import { mail } from "~/components/mail/index.server";
import {
  syncSide,
  recordsSlot,
  readBatchSlot,
  readBootstrapSlot,
  readSnapshotSlot,
  streamMessageSlot,
} from "~/components/sync";
import { publishAccountNotice, createAccountStream } from "~/components/sync/index.server";

import { records, readBatch, readBootstrap, readSnapshot, streamMessage } from "@/demo/client";

/** Keep migration inside each test; copy only the empty database's ready state. */
let template: PGliteInterface;

beforeAll(async () => {
  const [{ PGlite }] = await Promise.all([
    import("@electric-sql/pglite"),
    import("drizzle-orm/pglite"),
  ]);
  template = await PGlite.create();
}, 60_000);

afterAll(() => template.close());

export const databaseQueries: string[] = [];
export const transactionQueries: string[] = [];

/** Explicit local proof wiring; production factories always use Postgres and SMTP. */
export const proofDatabase = preset(
  database,
  async (_deps, { defer }): Promise<Database.Handle> => {
    const { drizzle } = await import("drizzle-orm/pglite");

    const client: import("@electric-sql/pglite").PGlite = await template.clone();

    defer(() => client.close());

    const handle = Object.assign(
      drizzle({
        client,
        logger: {
          logQuery(query) {
            databaseQueries.push(query);
          },
        },
      }),
      {
        listen: async (wake: (payload: string) => void) => client.listen("start_sync", wake),
      },
    );
    // PGlite has one connection; checkout serializes whole write sessions, like its native transaction.
    let previous = Promise.resolve();
    return Object.assign(handle, {
      async checkout(guard?: Database.QueryGuard) {
        const released = Promise.withResolvers<void>();

        const connection = new Proxy(client, {
          get(target, key) {
            if (key === "release") return released.resolve;

            if (key === "query") {
              return (text: string, ...args: unknown[]) => {
                if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text)) transactionQueries.push(text);

                return Reflect.apply(target.query.bind(target), target, [text, ...args]);
              };
            }
            return Reflect.get(target, key, target);
          },
        }) as typeof client & { release(broken?: boolean): void };

        return leaseFrom(
          async () => {
            const before = previous;
            previous = released.promise;
            await before;
            return connection;
          },
          drizzle,
          guard && {
            ...guard,
            logQuery(query) {
              databaseQueries.push(query);
            },
          },
        );
      },
    });
  },
);

export const proofMail = preset(mail, async (_deps, { log }) => ({
  send: async () => {
    log("mail.recorded", { delivered: false });
  },
}));

export { requestHeaders } from "~/components/requests/index.server";
export { handleAuth } from "~/components/auth/index.server";

/** Test entries bind the same three hooks as the server command. */
export const authBindings = [
  userCreated((accountId, ctx) => ctx.run(createAccountStream, { rawInput: { accountId } })),
  sendAuthMail((message, ctx) => ctx.resolve(authMail).enqueue(message)),
  sessionDeleted((accountId, ctx) => ctx.run(publishAccountNotice, { rawInput: { accountId } })),
];

export const clientBindings = [
  syncSide("tab"),
  recordsSlot(records),
  readBatchSlot(readBatch),
  readBootstrapSlot(readBootstrap),
  readSnapshotSlot(readSnapshot),
  streamMessageSlot(streamMessage),
];
