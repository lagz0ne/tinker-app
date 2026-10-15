import type { PGliteInterface } from "@electric-sql/pglite";
import type { Scope } from "@tinker/core";
import { preset } from "@tinker/core/testing";
import { afterAll, beforeAll } from "vite-plus/test";

import { sendAuthMail, sessionDeleted } from "~/components/auth/index.server";
import { database } from "~/components/database/index.server";
import type { Database } from "~/components/database/index.server";
import { records, readBatch, readBootstrap, readSnapshot, streamMessage } from "~/components/demo";
import { authMail } from "~/components/mail/index.server";
import { mail } from "~/components/mail/index.server";
import {
  recordsSlot,
  readBatchSlot,
  readBootstrapSlot,
  readSnapshotSlot,
  streamMessageSlot,
} from "~/components/sync";
import { publishAccountNotice } from "~/components/sync/index.server";

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

/** Explicit local proof wiring; production factories always use Postgres and SMTP. */
export const proofDatabase = preset(
  database,
  async (_deps, { defer }): Promise<Database.Handle> => {
    const { drizzle } = await import("drizzle-orm/pglite");
    const client = await template.clone();
    defer(() => client.close());
    return Object.assign(drizzle({ client }), {
      listen: async (wake: (payload: string) => void) => client.listen("start_sync", wake),
    });
  },
);

export const proofMail = preset(mail, async (_deps, { log }) => ({
  send: async () => {
    log("mail.recorded", { delivered: false });
  },
}));

export { requestHeaders } from "@tinker/start/testing";
export { handleAuth } from "@tinker/start/testing";

/** Test entries bind the same two hooks as the server command. */
export function authBindings(root: () => Scope.Handle) {
  return [
    sendAuthMail((message) => root().resolve(authMail).enqueue(message)),
    sessionDeleted((accountId) => root().run(publishAccountNotice, { rawInput: { accountId } })),
  ];
}

export const clientBindings = [
  recordsSlot(records),
  readBatchSlot(readBatch),
  readBootstrapSlot(readBootstrap),
  readSnapshotSlot(readSnapshot),
  streamMessageSlot(streamMessage),
];
