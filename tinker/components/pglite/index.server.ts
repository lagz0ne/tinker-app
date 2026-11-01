import { PGlite } from "@electric-sql/pglite";
import { capsule, resource, tag } from "@tinker/core";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import type { PgConnection } from "~/components/drizzle-pg/index.server";

/** Where PGlite keeps its files; unset keeps the database in memory. */
const dataDir = tag<string | undefined>({ label: "pglite.dataDir", default: undefined });

const connection = resource({
  label: "pglite.connection",
  depends: { dataDir },
  factory: async ({ dataDir }, { defer }): Promise<PgConnection> => {
    const client = new PGlite(dataDir);
    defer(() => client.close());
    const db = drizzle({ client });

    return {
      db,
      migrate: async (folder) => void (await migrate(db, { migrationsFolder: folder })),
    };
  },
});

/**
 * Postgres in process (WASM), for tests: no server. One connection, so a read outside a
 * transaction waits while another session's transaction is open.
 */
export const pglite = capsule({ label: "pglite", config: { dataDir }, exports: { connection } });
