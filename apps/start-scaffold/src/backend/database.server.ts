import { extension, operation, resource } from "@tinker/core";
import type { Database } from "@tinker/start/server";

export type { Database } from "@tinker/start/server";
import { env } from "@tinker/start/server";
import { z } from "zod";
import { raise } from "../errors";
import { postgres, drizzlePostgres, drizzlePgCore, drizzleMigrator } from "./modules";

const databaseEnv = z.object({ DATABASE_URL: z.string().min(1) });

export const databaseSettings = resource({
  label: "database.settings",
  depends: { env },
  factory: ({ env }) => {
    const settings = databaseEnv.safeParse(env);
    if (!settings.success)
      raise("BadSettings", {
        part: "database",
        keys: settings.error.issues.map((issue) => issue.path.join(".")),
      });
    return { url: settings.data.DATABASE_URL, migrations: "drizzle" };
  },
});

/** Feature code uses native PostgreSQL queries, without the driver's client field. */
const postgresDatabase = resource({
  label: "database.postgres",
  depends: { settings: databaseSettings, postgres, orm: drizzlePostgres },
  factory: async ({ settings, postgres, orm }, { defer }): Promise<Database.Handle> => {
    const { default: pg } = postgres;
    const { drizzle } = orm;
    const client = new pg.Pool({ connectionString: settings.url });
    const listeners = new Set<AbortController>();
    defer(async () => {
      for (const stop of listeners) stop.abort();
      await client.end();
    });
    return Object.assign(drizzle({ client }), {
      async listen(wake: () => void, disconnected: () => void) {
        const listener = await client.connect();
        listener.on("notification", wake);
        listener.on("error", disconnected);
        listener.on("end", disconnected);
        const stop = new AbortController();
        listeners.add(stop);
        stop.signal.addEventListener(
          "abort",
          () => {
            listeners.delete(stop);
            listener.removeListener("notification", wake);
            listener.removeListener("error", disconnected);
            listener.removeListener("end", disconnected);
            listener.release(true);
          },
          { once: true },
        );
        try {
          await listener.query("LISTEN start_sync");
          return stop.abort.bind(stop);
        } catch (error) {
          stop.abort();
          throw error;
        }
      },
    });
  },
});

/** A PGlite preset leaves the unused Postgres graph unbuilt. */
const selectPostgresDatabase = operation({
  label: "database.selectPostgres",
  depends: { database: postgresDatabase },
  run: async ({ database }) => database,
});

export const database = resource({
  label: "database",
  depends: { select: selectPostgresDatabase },
  factory: async ({ select }): Promise<Database.Handle> => select.run(),
});

export const migrate = operation({
  label: "migrate",
  depends: {
    database,
    settings: databaseSettings,
    pgCore: drizzlePgCore,
    migrator: drizzleMigrator,
  },
  run: async ({ database, settings, pgCore, migrator }) => {
    const { migrate } = pgCore;
    const { readMigrationFiles } = migrator;
    await migrate(readMigrationFiles({ migrationsFolder: settings.migrations }), database, {
      migrationsFolder: settings.migrations,
    });
  },
});

export const databaseSetup = extension({
  label: "database.setup",
  hooks: {
    async start({ next, scope }) {
      await next();
      await scope.run(migrate);
    },
  },
});
