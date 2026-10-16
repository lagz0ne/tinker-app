import { extension, operation, resource, tag } from "@tinker/core";
import type { PoolClient } from "pg";
import { z } from "zod";

import { fail } from "~/components/errors";

import { leaseFrom } from "./lease.server";
import { postgres, drizzlePostgres, drizzlePgCore, drizzleMigrator } from "./modules";
import type { Database } from "./types";

/** Where Postgres is. */
export const databaseUrl = tag<URL>({ label: "database.url", parse: z.instanceof(URL) });

/** Worker-only soft stop cancels pool reads, while in-flight write leases finish. */
export const databaseStop = tag<AbortSignal | undefined>({
  label: "database.stop",
  default: undefined,
});

export const databaseConnectTimeout = tag<number>({
  label: "database.connectTimeout",
  default: 5000,
  parse: z.number().int().positive(),
});

const migrationsFolder = "drizzle";

/** Feature code uses native PostgreSQL queries, without the driver's client field. */
export const database = resource({
  label: "database",
  depends: {
    url: databaseUrl,
    postgres,
    orm: drizzlePostgres,
    stopping: databaseStop,
    timeout: databaseConnectTimeout,
  },
  factory: async (
    { url, postgres, orm, stopping, timeout },
    { defer },
  ): Promise<Database.Handle> => {
    const { default: pg } = postgres;
    const { drizzle } = orm;

    const client = new pg.Pool({ connectionString: url.href, connectionTimeoutMillis: timeout });

    const listeners = new Set<AbortController>();

    defer(async () => {
      for (const stop of listeners) stop.abort();
      await client.end();
    });

    const reads = new Proxy(client, {
      get(target, key) {
        if (key !== "query" || !stopping) return Reflect.get(target, key, target);

        /** Native pg callback; the resource owns its client and stop listener. */
        return async function queryWithStop(...args: unknown[]) {
          stopping.throwIfAborted();

          let held: PoolClient | undefined;

          const cancelled = Promise.withResolvers<never>();

          const abort = () => {
            held?.release(true);

            held = undefined;

            cancelled.reject(stopping.reason);
          };

          stopping.addEventListener("abort", abort, { once: true });

          const work = Promise.resolve().then(async () => {
            const connection = await client.connect();

            if (stopping.aborted) {
              connection.release(true);

              throw stopping.reason;
            }
            held = connection;

            try {
              return await Reflect.apply(connection.query.bind(connection), connection, args);
            } finally {
              held?.release();

              held = undefined;
            }
          });

          try {
            return await Promise.race([work, cancelled.promise]);
          } finally {
            stopping.removeEventListener("abort", abort);
          }
        };
      },
    });

    return Object.assign(drizzle({ client: reads }), {
      async checkout(guard?: Database.QueryGuard): Promise<Database.Lease> {
        // The lease is only a handle. Its first BEGIN checks out the pool client.
        return leaseFrom<PoolClient>(client.connect.bind(client), drizzle, guard);
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

    let ending: Promise<void> | undefined;

    let broken = false;

    const lease = await database.checkout({
      check() {
        if (state === "committed" || state === "rolledBack") throw fail("TransactionEnded", {});
      },
      async begin() {
        if (state === "committed" || state === "rolledBack") throw fail("TransactionEnded", {});
        if (state === "idle") {
          state = "open";

          starting = lease.query("BEGIN").catch((error) => {
            broken = true;

            throw error;
          });
        }
        await starting;
      },
    });
    const tx = Object.assign(lease.db, {
      transaction() {
        throw fail("NestedTransaction", {});
      },
      commit() {
        if (state === "committed" || state === "rolledBack") return Promise.resolve();

        const opened = state === "open";
        state = "committed";

        if (!opened) return Promise.resolve();

        ending = Promise.resolve(starting)
          .then(() => lease.query("COMMIT"))
          .then(() => {})
          .catch(async (error) => {
            broken = true;

            state = "rolledBack";
            await lease.query("ROLLBACK").catch(() => {});
            throw error;
          });

        void ending.catch(() => {});

        return ending;
      },
      rollback() {
        if (state === "committed" || state === "rolledBack") return Promise.resolve();

        const opened = state === "open";
        state = "rolledBack";

        if (!opened) return Promise.resolve();

        ending = Promise.resolve(starting)
          .catch(() => {})
          .then(() => lease.query("ROLLBACK"))
          .then(() => {})
          .catch((error) => {
            broken = true;

            throw error;
          });

        void ending.catch(() => {});

        return ending;
      },
    });

    defer(async (end) => {
      try {
        await ending;

        if (state === "open") {
          if (end.status === "success") await tx.commit();
          else await tx.rollback();
        }
      } finally {
        lease.release(broken);
      }
    });
    return tx;
  },
});
