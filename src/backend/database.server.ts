import { extension, operation, resource, tag } from "@tinker/core";
import type { Database } from "@tinker/start/server";

export type { Database } from "@tinker/start/server";
import { postgres, drizzlePostgres, drizzlePgCore, drizzleMigrator } from "./modules";

/** Where Postgres is. */
export const databaseUrl = tag<URL>({ label: "database.url" });

const migrationsFolder = "drizzle";

/** Feature code uses native PostgreSQL queries, without the driver's client field. */
export const database = resource({
  label: "database",
  depends: { url: databaseUrl, postgres, orm: drizzlePostgres },
  factory: async ({ url, postgres, orm }, { defer }): Promise<Database.Handle> => {
    const { default: pg } = postgres;
    const { drizzle } = orm;
    const client = new pg.Pool({ connectionString: url.href });
    const listeners = new Set<AbortController>();

    defer(async () => {
      for (const stop of listeners) stop.abort();
      await client.end();
    });

    return Object.assign(drizzle({ client }), {
      async listen(heard: (payload: string) => void, disconnected: () => void) {
        const listener = await client.connect();
        const notified = (message: { payload?: string }) => heard(message.payload ?? "");
        listener.on("notification", notified);
        listener.on("error", disconnected);
        listener.on("end", disconnected);

        const stop = new AbortController();
        listeners.add(stop);

        stop.signal.addEventListener(
          "abort",
          () => {
            listeners.delete(stop);
            listener.removeListener("notification", notified);
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

export const migrate = operation({
  label: "migrate",
  depends: {
    database,
    pgCore: drizzlePgCore,
    migrator: drizzleMigrator,
  },
  run: async ({ database, pgCore, migrator }) => {
    const { migrate } = pgCore;
    const { readMigrationFiles } = migrator;
    await migrate(readMigrationFiles({ migrationsFolder }), database, { migrationsFolder });
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
