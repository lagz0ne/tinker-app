import { extension, operation, resource, tag } from "@tinker/core";
import type { PoolClient } from "pg";
import { z } from "zod";

import { fail } from "~/components/errors";

import { leaseFrom } from "./lease.server";
import { postgres, drizzlePostgres, drizzlePgCore, drizzleMigrator, drizzleOrm } from "./modules";
import type { Database } from "./types";

/** Where Postgres is. */
export const databaseUrl = tag<URL>({ label: "database.url", parse: z.instanceof(URL) });

/** Worker-only stop cancels startup and pool reads; in-flight write leases finish. */
export const databaseStop = tag<AbortSignal | undefined>({
  label: "database.stop",
  default: undefined,
});

export const databaseConnectTimeout = tag<number>({
  label: "database.connectTimeout",
  default: 5000,
  parse: z.number().int().positive(),
});

/** Per-statement transaction bounds also cover COMMIT and deferred constraints. */
export const databaseLockTimeout = tag<number>({
  label: "database.lockTimeout",
  default: 500,
  parse: z.number().int().positive().max(1000),
});

export const databaseStatementTimeout = tag<number>({
  label: "database.statementTimeout",
  default: 1000,
  parse: z.number().int().positive().max(2000),
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
      async listen(
        channel: string,
        heard: (payload: string) => void,
        disconnected: () => void,
        signal?: AbortSignal,
      ) {
        const topic = z
          .string()
          .regex(/^[a-z_][a-z0-9_]{0,62}$/)
          .parse(channel);

        signal?.throwIfAborted();

        const stop = new AbortController();

        const cancelled = Promise.withResolvers<never>();

        let listener: PoolClient | undefined;

        const notified = (message: { payload?: string }) => heard(message.payload ?? "");

        const abort = () => stop.abort(signal?.reason);

        listeners.add(stop);

        stop.signal.addEventListener(
          "abort",
          () => {
            listeners.delete(stop);

            signal?.removeEventListener("abort", abort);

            listener?.removeListener("notification", notified);

            listener?.removeListener("error", disconnected);

            listener?.removeListener("end", disconnected);

            listener?.release(true);

            cancelled.reject(stop.signal.reason);
          },
          { once: true },
        );

        signal?.addEventListener("abort", abort, { once: true });

        const pending = client.connect().then((connection) => {
          if (stop.signal.aborted) {
            connection.release(true);

            throw stop.signal.reason;
          }
          listener = connection;

          return connection;
        });

        try {
          await Promise.race([pending, cancelled.promise]);

          stop.signal.throwIfAborted();

          listener!.on("notification", notified);

          listener!.on("error", disconnected);

          listener!.on("end", disconnected);

          await Promise.race([listener!.query(`LISTEN ${topic}`), cancelled.promise]);

          return stop.abort.bind(stop);
        } catch (error) {
          stop.abort(error);

          throw error;
        }
      },
    });
  },
});

/** Bound how long another process may own schema migration at startup. */
export const databaseMigrationTimeout = tag<number>({
  label: "database.migrationTimeout",
  default: 5000,
  parse: z.number().int().positive().max(60000),
});

/** Stable application schema lock: ASCII TINK / MIGR, shared by every process. */
export const migrationLockKey = [1414090315, 1296648018] as const;

export const migrate = operation({
  label: "migrate",
  depends: {
    database,
    pgCore: drizzlePgCore,
    migrator: drizzleMigrator,
    orm: drizzleOrm,
    timeout: databaseMigrationTimeout,
  },
  run: async ({ database, pgCore, migrator, orm, timeout }, { clock, signal }) => {
    if (!database.checkout) throw new Error("Migration requires a dedicated connection");
    const lease = await database.checkout();
    const lock = orm.sql`SELECT pg_try_advisory_lock(${migrationLockKey[0]}, ${migrationLockKey[1]}) AS owned`;
    const deadline = clock.currentTimeMillis() + timeout;
    let broken = true;

    let released = false;

    const abort = () => {
      released = true;
      lease.release(true);
    };

    try {
      while (true) {
        signal.throwIfAborted();
        const result = z
          .object({ rows: z.array(z.object({ owned: z.boolean() })) })
          .parse(await lease.db.execute(lock));
        if (result.rows[0]!.owned) break;
        if (clock.currentTimeMillis() >= deadline) throw fail("MigrationBusy", { timeout });
        await clock.sleep(Math.min(50, deadline - clock.currentTimeMillis()), signal);
      }
      // Checkout has completed. An abort can now destroy this exact connection.
      signal.addEventListener("abort", abort, { once: true });
      signal.throwIfAborted();
      await pgCore.migrate(migrator.readMigrationFiles({ migrationsFolder }), lease.db, {
        migrationsFolder,
      });

      await lease.db.execute(
        orm.sql`SELECT pg_advisory_unlock(${migrationLockKey[0]}, ${migrationLockKey[1]})`,
      );
      broken = false;
    } finally {
      signal.removeEventListener("abort", abort);
      // Any failed migration/unlock destroys the connection and releases its lock.
      if (!released) lease.release(broken);
    }
  },
});

export const databaseSetup = extension({
  label: "database.setup",
  hooks: {
    async start({ resolve, next, scope }) {
      resolve(databaseUrl);
      await next();
      await scope.run(migrate, { signal: resolve(databaseStop) });
    },
  },
});

/** The call's session owns a lazy transaction and waits for its end before returning. */
export const transaction = resource({
  label: "database.transaction",
  target: "session",
  depends: {
    database,
    lockTimeout: databaseLockTimeout,
    statementTimeout: databaseStatementTimeout,
  },
  factory: async (
    { database, lockTimeout, statementTimeout },
    { defer },
  ): Promise<Database.SessionTransaction> => {
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

          starting = lease
            .query("BEGIN")
            .then(() => lease.query(`SET LOCAL lock_timeout = '${lockTimeout}ms'`))
            .then(() => lease.query(`SET LOCAL statement_timeout = '${statementTimeout}ms'`))
            .catch((error) => {
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
        if (state === "idle" || state === "open") {
          if (end.status === "success") await tx.commit();
          else await tx.rollback();
        }
        await ending;
      } finally {
        lease.release(broken);
      }
    });
    return tx;
  },
});
