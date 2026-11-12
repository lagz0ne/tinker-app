import { capsule, data, operation, resource, tag } from "@tinkered/core";
import type { Resource } from "@tinkered/core";
import type { SQLiteAsyncDatabase } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import type { Errors } from "~/components/errors";

/** Any SQLite-dialect Drizzle database: bun:sqlite, libSQL, better-sqlite3. */
export type SqliteDb = SQLiteAsyncDatabase<"sync" | "async", any, any>;
export type SqliteTx = Parameters<Parameters<SqliteDb["transaction"]>[0]>[0];

/**
 * What a SQLite driver library gives. `begin` is the driver's own: a sync driver (bun:sqlite)
 * cannot hold Drizzle's transaction callback open across an `await`; an async one can.
 */
export type SqliteConnection = {
  readonly db: SqliteDb;
  readonly migrate: (folder: string) => Promise<void>;
  readonly begin: () => Promise<{
    readonly tx: SqliteDb | SqliteTx;
    readonly end: (commit: boolean) => Promise<void>;
  }>;
};

/** The driver's connection resource: `bunSqlite.connection`. */
const driver = tag<Resource.Handle<Promise<SqliteConnection>>>({ label: "drizzleSqlite.driver" });

/** The drizzle-kit `out` folder, relative to the working directory; `false` skips migrate. */
const migrations = tag<string | false>({
  label: "drizzleSqlite.migrations",
  default: "drizzle/sqlite",
  parse: z.union([z.string().min(1), z.literal(false)]),
});

/** The bound driver's connection, written once at start (see `drizzlePg`: same Core gap). */
const opened = data<SqliteConnection | undefined>({ initial: undefined });

/** The root's own closing signal, written at start. A session resource built with this very
 * signal was built on the root itself: no call owns it, so it would never end. */
const rootClosing = data<AbortSignal | undefined>({ initial: undefined });

const connection = resource({
  label: "drizzleSqlite.connection",
  depends: { opened },
  factory: ({ opened }, { raise: coreRaise }): SqliteConnection => {
    const raise: Errors.Raise = coreRaise;

    return opened ?? raise("DatabaseNotStarted", { label: "drizzleSqlite" });
  },
});

/** The shared db: reads and single statements outside a transaction. */
const db = resource({
  label: "drizzleSqlite.db",
  depends: { connection },
  factory: async ({ connection }) => connection.db,
});

/** SQLite has one writer: sessions take turns, in order. */
const writeTurn = resource({
  label: "drizzleSqlite.writeTurn",
  factory: () => {
    let tail: Promise<void> = Promise.resolve();

    return {
      take: async (): Promise<() => void> => {
        const turn = Promise.withResolvers<void>();
        const before = tail;
        tail = tail.then(() => turn.promise);
        await before;

        return turn.resolve;
      },
    };
  },
});

/** One transaction per session, in its write turn. Success commits, anything else rolls back. */
const tx = resource({
  label: "drizzleSqlite.tx",
  target: "session",
  depends: { connection, writeTurn, root: rootClosing },
  factory: async ({ connection, writeTurn, root }, { closing, defer, raise: coreRaise }) => {
    const raise: Errors.Raise = coreRaise;

    // The boundary rule, as in `drizzlePg`.
    if (closing === root) return raise("TransactionNeedsSession", { label: "drizzleSqlite" });

    const release = await writeTurn.take();
    try {
      const { tx, end } = await connection.begin();
      defer((ended) => end(ended.status === "success").finally(release));

      return tx;
    } catch (error) {
      release();
      throw error;
    }
  },
});

/** Brings the schema up to date with the driver's own Drizzle migrator. */
const migrate = operation({
  label: "drizzleSqlite.migrate",
  depends: { connection, folder: migrations },
  run: async ({ connection, folder }) => {
    if (folder !== false) await connection.migrate(folder);
  },
});

/** The Drizzle facade for the SQLite dialect. */
export const drizzleSqlite = capsule({
  label: "drizzleSqlite",
  config: { driver: driver.required, migrations },
  exports: { db, tx, migrate },
  hooks: {
    async start({ next, run, load, config, closing }) {
      // Migrate first, then the later capsules start: Flyway and Rails migrate before the app
      // serves, so a later start reads the schema and no write waits on migrate's lock.
      load(rootClosing, { role: "state", explain: "Marks the root, for the boundary rule" }).set(
        closing,
      );
      const meta = { role: "state", explain: "The driver's Drizzle connection" } as const;
      load(opened, { role: "state", explain: "Hands the connection to db, tx and migrate" }).set(
        await load(config.driver, meta),
      );
      await run(migrate, {}, { role: "setup", explain: "Brings the schema up to date" });
      await next();
    },
  },
});
