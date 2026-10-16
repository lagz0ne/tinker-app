import { extension, operation, resource, tag } from "@tinker/core";
import { z } from "zod";

import { fail } from "~/components/errors";

import { postgres, drizzlePostgres, drizzlePgCore, drizzleMigrator } from "./modules";
import type { Database } from "./types";

/** Where Postgres is. */
export const databaseUrl = tag<URL>({ label: "database.url", parse: z.instanceof(URL) });

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
      async checkout(guard?: Database.QueryGuard): Promise<Database.Lease> {
        const connection = await client.connect();
        const query = new Proxy(connection.query.bind(connection), {
          async apply(query, receiver, args) {
            await guard?.begin();
            return Reflect.apply(query, receiver, args);
          },
        });
        return {
          db: drizzle({
            client: new Proxy(connection, {
              get(target, key) {
                if (key === "query") return query;
                return Reflect.get(target, key, target);
              },
            }),
            // Keep TransactionEnded outside Drizzle's driver-error wrapper.
            logger: { logQuery: () => guard?.check() },
          }),
          query: connection.query.bind(connection),
          release: connection.release.bind(connection),
        };
      },
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
    async start({ resolve, next, scope }) {
      resolve(databaseUrl);
      await next();
      await scope.run(migrate);
    },
  },
});

/** The call's session owns a lazy transaction and waits for its end before returning. */
export const transaction = resource({
  label: "database.transaction",
  target: "session",
  depends: { database },
  factory: async ({ database }, { defer }): Promise<Database.SessionTransaction> => {
    if (!database.checkout) throw new Error("Database preset must supply checkout for writes");
    let state: "idle" | "open" | "committed" | "rolledBack" = "idle";
    let starting: Promise<unknown> | undefined;
    let ending: Promise<unknown> | undefined;
    const lease = await database.checkout({
      check() {
        if (state === "committed" || state === "rolledBack") throw fail("TransactionEnded", {});
      },
      async begin() {
        if (state === "committed" || state === "rolledBack") throw fail("TransactionEnded", {});
        if (state === "idle") {
          state = "open";
          starting = lease.query("BEGIN");
        }
        await starting;
      },
    });
    const tx = Object.assign(lease.db, {
      async commit() {
        if (state === "committed" || state === "rolledBack") return;
        const opened = state === "open";
        state = "committed";

        if (!opened) return;
        ending = Promise.resolve(starting)
          .then(() => lease.query("COMMIT"))
          .catch(async (error) => {
            state = "rolledBack";
            await lease.query("ROLLBACK").catch(() => {});
            throw error;
          });
        await ending;
      },
      async rollback() {
        if (state === "committed" || state === "rolledBack") return;
        const opened = state === "open";
        state = "rolledBack";

        if (!opened) return;
        ending = Promise.resolve(starting)
          .catch(() => {})
          .then(() => lease.query("ROLLBACK"));
        await ending;
      },
    });

    defer(async (end) => {
      try {
        await ending?.catch(() => {});
        if (state === "open") {
          if (end.status === "success") await tx.commit();
          else await tx.rollback();
        }
      } finally {
        lease.release();
      }
    });
    return tx;
  },
});
