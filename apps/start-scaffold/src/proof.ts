import { preset } from "@tinker/core/testing";
import { database } from "./backend/database.ts";
import { mail } from "./backend/mail.ts";
import type { Database } from "./backend/database.ts";
/** Explicit local proof wiring; production factories always use Postgres and SMTP. */
export const proofDatabase = preset(database, async (_deps, ctx): Promise<Database.Handle> => {
  const [{ PGlite }, { drizzle }] = await Promise.all([
    import("@electric-sql/pglite"),
    import("drizzle-orm/pglite"),
  ]);
  const client = await PGlite.create();
  ctx.defer(() => client.close());
  return Object.assign(drizzle({ client }), {
    listen: async (wake: () => void) => client.listen("start_sync", wake),
  });
});
export const proofMail = preset(mail, async (_deps, ctx) => ({
  send: async () => {
    ctx.log("mail.recorded", { delivered: false });
  },
}));
