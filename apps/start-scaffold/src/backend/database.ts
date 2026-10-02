import { operation, resource, tag } from "@tinker/core";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
export declare namespace Database {
  type Handle = PgAsyncDatabase<PgQueryResultHKT> & {
    listen: (wake: () => void, disconnected: () => void) => Promise<() => Promise<void>>;
  };
  type Transaction = Parameters<Parameters<Handle["transaction"]>[0]>[0];
}
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
    ctx.defer(() => client.end());
    return Object.assign(drizzle({ client }), {
      async listen(wake: () => void, disconnected: () => void) {
        const listener = await client.connect();
        listener.on("notification", wake);
        listener.on("error", disconnected);
        listener.on("end", disconnected);
        let released = false;
        const close = async () => {
          if (released) return;
          released = true;
          listener.removeListener("notification", wake);
          listener.removeListener("error", disconnected);
          listener.removeListener("end", disconnected);
          listener.release(true);
        };
        try {
          await listener.query("LISTEN start_sync");
          return close;
        } catch (error) {
          await close();
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
