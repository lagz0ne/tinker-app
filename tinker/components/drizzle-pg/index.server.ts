import { capsule, data, operation, resource, tag } from "@tinker/core";
import type { Resource } from "@tinker/core";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { Errors } from "~/components/errors";

/** Any Postgres-dialect Drizzle database: Bun.sql, PGlite, postgres-js, node-postgres. */
export type PgDb = PgAsyncDatabase<PgQueryResultHKT, any>;
export type PgTx = Parameters<Parameters<PgDb["transaction"]>[0]>[0];

/** What a Postgres driver library gives: its Drizzle db and its own migrator. */
export type PgConnection = {
  readonly db: PgDb;
  readonly migrate: (folder: string) => Promise<void>;
};

/** The driver's connection resource: `bunSql.connection`, `pglite.connection`. */
const driver = tag<Resource.Handle<Promise<PgConnection>>>({ label: "drizzlePg.driver" });

/** The drizzle-kit `out` folder, relative to the working directory; `false` skips migrate. */
const migrations = tag<string | false>({
  label: "drizzlePg.migrations",
  default: "drizzle/pg",
  parse: z.union([z.string().min(1), z.literal(false)]),
});

/**
 * The bound driver's connection. Start loads the driver and writes it here once, before any
 * unit reads it. A tag cannot name a resource yet (Core gap), so a cell carries the value.
 */
const opened = data<PgConnection | undefined>({ initial: undefined });

/** The root's own closing signal, written at start. A session resource built with this very
 * signal was built on the root itself: no call owns it, so it would never end. */
const rootClosing = data<AbortSignal | undefined>({ initial: undefined });

const connection = resource({
  label: "drizzlePg.connection",
  depends: { opened },
  factory: ({ opened }, { raise: coreRaise }): PgConnection => {
    const raise: Errors.Raise = coreRaise;

    return opened ?? raise("DatabaseNotStarted", { label: "drizzlePg" });
  },
});

/** The shared db: reads and single statements outside a transaction. */
const db = resource({
  label: "drizzlePg.db",
  depends: { connection },
  factory: async ({ connection }) => connection.db,
});

/**
 * One transaction per session, opened on first use: Drizzle's own transaction call, held open
 * until the session ends. Success commits; a failure or a forced close rolls back (ADR 0028).
 */
const tx = resource({
  label: "drizzlePg.tx",
  target: "session",
  depends: { connection, root: rootClosing },
  factory: async ({ connection, root }, { closing, defer, raise: coreRaise }): Promise<PgTx> => {
    const raise: Errors.Raise = coreRaise;

    // The boundary rule: a transaction belongs to a call's own session (a request, a call
    // with `signal` or `tags`, or `createSession()`), never to the root.
    if (closing === root) return raise("TransactionNeedsSession", { label: "drizzlePg" });

    const opened = Promise.withResolvers<PgTx>();
    const ended = Promise.withResolvers<boolean>();
    const done = connection.db
      .transaction(async (inner) => {
        opened.resolve(inner);
        if (!(await ended.promise)) inner.rollback();
      })
      .catch((error: unknown) => {
        if (Object(error).name !== "TransactionRollbackError") throw error;
      });
    const found = await Promise.race([opened.promise, done.then(() => undefined)]);
    if (!found) return raise("TransactionNotOpened", { label: "drizzlePg" });
    defer(async (end) => {
      ended.resolve(end.status === "success");
      await done;
    });

    return found;
  },
});

/** Brings the schema up to date with the driver's own Drizzle migrator. */
const migrate = operation({
  label: "drizzlePg.migrate",
  depends: { connection, folder: migrations },
  run: async ({ connection, folder }) => {
    if (folder !== false) await connection.migrate(folder);
  },
});

/**
 * The Drizzle facade for the Postgres dialect. The command names the driver; the app's
 * operations depend on `drizzlePg.tx` or `drizzlePg.db` and never see which driver it is.
 */
export const drizzlePg = capsule({
  label: "drizzlePg",
  config: { driver: driver.required, migrations },
  exports: { db, tx, migrate },
  hooks: {
    async start({ next, run, load, config, closing }) {
      await next();
      load(rootClosing, { role: "state", explain: "Marks the root, for the boundary rule" }).set(
        closing,
      );
      const meta = { role: "state", explain: "The driver's Drizzle connection" } as const;
      load(opened, { role: "state", explain: "Hands the connection to db, tx and migrate" }).set(
        await load(config.driver, meta),
      );
      await run(migrate, {}, { role: "setup", explain: "Brings the schema up to date" });
    },
  },
});
