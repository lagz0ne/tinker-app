import { Database } from "bun:sqlite";

import { capsule, resource, tag } from "@tinker/core";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { z } from "zod";

import type { SqliteConnection } from "~/components/drizzle-sqlite/index.server";

/** The database file; `:memory:` keeps it in memory. */
const file = tag<string>({
  label: "bunSqlite.file",
  default: ":memory:",
  parse: z.string().min(1),
});

const connection = resource({
  label: "bunSqlite.connection",
  depends: { file },
  factory: async ({ file }, { defer }): Promise<SqliteConnection> => {
    const client = new Database(file);
    client.exec("PRAGMA journal_mode = WAL");
    client.exec("PRAGMA foreign_keys = ON");
    defer(() => client.close());
    const db = drizzle({ client });

    return {
      db,
      migrate: async (folder) => void migrate(db, { migrationsFolder: folder }),
      // A sync driver: plain BEGIN and COMMIT on the one connection. The facade's write turn
      // keeps other sessions' transactions off it meanwhile.
      begin: async () => {
        client.exec("BEGIN IMMEDIATE");

        return { tx: db, end: async (commit) => void client.exec(commit ? "COMMIT" : "ROLLBACK") };
      },
    };
  },
});

/** SQLite through Bun's own `bun:sqlite`: sync, in process, one connection. */
export const bunSqlite = capsule({ label: "bunSqlite", config: { file }, exports: { connection } });
