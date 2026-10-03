import { operation, resource, tag } from "@tinker/core";
import type { Database } from "../scaffold/backend/database.ts";
export type { Database } from "../scaffold/backend/database.ts";
export const databaseSettings = tag<{ url: string; migrations: string }>({
  label: "database.settings",
});
/** Feature code uses native PostgreSQL queries, without the driver's client field. */
export const database = resource({
  label: "database",
  depends: { settings: databaseSettings },
  factory: async ({ settings }, ctx): Promise<Database.Handle> => {
    const [{ default: pg }, { drizzle }] = await Promise.all([
      import("pg"),
      import("drizzle-orm/node-postgres"),
    ]);
    const client = new pg.Pool({ connectionString: settings.url });
    const listeners = new Set<AbortController>();
    ctx.defer(async () => {
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
export const migrate = operation({
  label: "migrate",
  depends: { database, settings: databaseSettings },
  run: async ({ database, settings }) => {
    const [{ migrate }, { readMigrationFiles }] = await Promise.all([
      import("drizzle-orm/pg-core"),
      import("drizzle-orm/migrator"),
    ]);
    await migrate(readMigrationFiles({ migrationsFolder: settings.migrations }), database, {
      migrationsFolder: settings.migrations,
    });
  },
});
