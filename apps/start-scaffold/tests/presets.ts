import { preset } from "@tinker/core/testing";
import type { PGliteInterface } from "@electric-sql/pglite";
import { afterAll, beforeAll } from "vite-plus/test";
import { database } from "@tinker-start-scaffold/backend";
import { mail } from "@tinker-start-scaffold/backend";
import type { Database } from "@tinker-start-scaffold/backend";

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
