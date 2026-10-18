import { createScope } from "@tinker/core";
import { preset } from "@tinker/core/testing";
import { expect, test } from "vite-plus/test";

import { databaseUrl, migrate } from "~/components/database/index.server";
import { drizzleMigrator, drizzlePgCore, postgres } from "~/components/database/modules";

test("migrations keep the same lock keys across process and release versions", async () => {
  const queries: { text: string; values: unknown[] }[] = [];
  const order: string[] = [];
  const root = createScope({
    tags: [databaseUrl(new URL("postgres://proof"))],
    presets: [
      preset(
        postgres,
        async () =>
          ({
            default: {
              Pool: function Pool() {
                return {
                  connect: async () => ({
                    query: async (config: { text: string }, values: unknown[]) => {
                      queries.push({ text: config.text, values });
                      order.push(config.text.includes("pg_try_advisory_lock") ? "lock" : "unlock");
                      return { rows: [{ owned: true }] };
                    },
                    release: (broken?: boolean) => {
                      expect(broken).toBe(false);
                      order.push("release");
                    },
                  }),
                  end: async () => {
                    order.push("end");
                  },
                };
              },
            },
          }) as unknown as typeof import("pg"),
      ),
      preset(
        drizzleMigrator,
        async () =>
          ({ readMigrationFiles: () => [] }) as unknown as typeof import("drizzle-orm/migrator"),
      ),
      preset(
        drizzlePgCore,
        async () =>
          ({
            migrate: async () => {
              order.push("migrate");
            },
          }) as unknown as typeof import("drizzle-orm/pg-core"),
      ),
    ],
  });
  try {
    await root.run(migrate);
    expect(queries.map((query) => query.values)).toEqual([
      [1414090315, 1296648018],
      [1414090315, 1296648018],
    ]);
    expect(order).toEqual(["lock", "migrate", "unlock", "release"]);
    await root.close({ graceful: true });
    expect(order).toEqual(["lock", "migrate", "unlock", "release", "end"]);
  } finally {
    await root.close();
  }
});
