import { capsule, resource, tag } from "@tinker/core";
import { SQL } from "bun";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { drizzle } from "drizzle-orm/bun-sql/postgres";
import { z } from "zod";

import type { PgConnection } from "~/components/drizzle-pg/index.server";

const url = tag<URL>({ label: "bunSql.url", parse: z.instanceof(URL), secret: true });
const max = tag<number>({ label: "bunSql.max", default: 10, parse: z.number().int().positive() });

const connection = resource({
  label: "bunSql.connection",
  depends: { url, max },
  factory: async ({ url, max }, { defer }): Promise<PgConnection> => {
    const client = new SQL({ url: url.href, max });
    defer(() => client.close());
    const db = drizzle({ client });

    return {
      db,
      migrate: async (folder) => void (await migrate(db, { migrationsFolder: folder })),
    };
  },
});

/** Postgres through Bun's own client, `Bun.sql`, with a pool. No npm driver. */
export const bunSql = capsule({
  label: "bunSql",
  config: { url: url.required, max },
  exports: { connection },
});
