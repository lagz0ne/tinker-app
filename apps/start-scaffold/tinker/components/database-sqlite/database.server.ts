import type { DatabaseSync } from "node:sqlite";

import { extension, operation, resource, tag } from "@tinker/core";
import { z } from "zod";

import { fail } from "~/components/errors";

import { sqlite, sqliteFs, sqlitePath, sqliteUrl } from "./modules";
import lastIdQuery from "./queries/last_id.sql";
import notifyQuery from "./queries/notify.sql";
import pollQuery from "./queries/poll.sql";
import trimQuery from "./queries/trim.sql";
import type { Database } from "./types";

/**
 * Where the SQLite file is: a `file:` URL, or a URL reference resolved against `databaseFolder`.
 * `file:./data/app.db`, `file:data/app.db`, and `./data/app.db` all name the same relative path.
 * A string follows URL rules, so `#` starts a fragment and `%20` decodes: a path that holds those
 * characters is written as a `file:` URL from `pathToFileURL`. An empty string is refused.
 */
export const databaseUrl = tag<URL | string>({
  label: "database.url",
  parse: z.union([
    z
      .instanceof(URL)
      .refine((url) => url.protocol === "file:", { error: "SQLite needs a file: URL" }),
    z
      .string()
      .min(1)
      .refine((value) => URL.parse(value, "file:///")?.protocol === "file:", {
        error: "SQLite needs a file: URL",
      }),
  ]),
});

/**
 * The app folder: the command passes `defineMain`'s `cwd`.
 * A relative `databaseUrl` string and a relative `databaseMigrationsFolder` resolve against it,
 * so a process started from another folder still opens the app's file.
 */
export const databaseFolder = tag<string | undefined>({
  label: "database.folder",
  default: undefined,
  parse: z.string().min(1).optional(),
});

/** Worker-only stop cancels the startup migration and its ownership wait. */
export const databaseStop = tag<AbortSignal | undefined>({
  label: "database.stop",
  default: undefined,
});

/** How long one connection waits on another process's lock before SQLITE_BUSY. */
export const databaseBusyTimeout = tag<number>({
  label: "database.busyTimeout",
  default: 5000,
  parse: z.number().int().nonnegative().max(60000),
});

/** Bound how long another process may own the schema at startup. */
export const databaseMigrationTimeout = tag<number>({
  label: "database.migrationTimeout",
  default: 5000,
  parse: z.number().int().positive().max(60000),
});

/**
 * The folder `migrate` reads numbered `.sql` files from: relative to `databaseFolder` when it is
 * bound, and to the working directory when it is not.
 */
export const databaseMigrationsFolder = tag<string>({
  label: "database.migrationsFolder",
  default: "sqlite/migrations",
  parse: z.string().min(1),
});

/** How often a listener polls `start_notify` for rows another process committed. */
export const databasePollInterval = tag<number>({
  label: "database.pollInterval",
  default: 100,
  parse: z.number().int().positive().max(60000),
});

/** How long a notify row is kept for a listener that has not read it yet. */
export const databaseNotifyRetention = tag<number>({
  label: "database.notifyRetention",
  default: 60000,
  parse: z.number().int().positive().max(3600000),
});

/** The same channel names the Postgres set accepts, so a payload name survives the move. */
const channelName = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);

/**
 * `node:sqlite` fails with an `errcode`; SQLITE_BUSY is 5, and an extended code keeps those bits.
 * Any other failure reads as 0, so it rethrows instead of waiting on a lock.
 */
const sqliteError = z.object({ errcode: z.number() }).catch({ errcode: 0 });

/**
 * One owner resolves the bound value to the absolute file path: a `URL` is used as given, and a
 * string is a reference resolved against `databaseFolder` (Rails and Prisma resolve it that way).
 */
export const databaseFile = resource({
  label: "database.file",
  target: "scope",
  depends: { url: databaseUrl, folder: databaseFolder, urls: sqliteUrl, paths: sqlitePath },
  factory: async ({ url, folder, urls, paths }): Promise<string> => {
    if (typeof url !== "string") return urls.fileURLToPath(url);

    // A command that forgot the folder fails loud; it never opens the disk-root file.
    if (folder === undefined) throw fail("DatabaseFolderMissing", {});

    // WHATWG reference resolution (RFC 3986 section 5) from the app folder, which pathToFileURL
    // percent-encodes: `%`, `#`, and `?` in the folder name stay part of the folder name.
    return urls.fileURLToPath(new URL(url, urls.pathToFileURL(paths.join(folder, "/"))));
  },
});

/** Feature code gets the two owned connections, the write turn, and notify delivery. */
export const database = resource({
  label: "database",
  depends: {
    file: databaseFile,
    sqlite,
    busyTimeout: databaseBusyTimeout,
    pollInterval: databasePollInterval,
    retention: databaseNotifyRetention,
  },
  factory: async (
    { file, sqlite, busyTimeout, pollInterval, retention },
    { closing, clock, defer, log },
  ): Promise<Database.Handle> => {
    const { DatabaseSync } = sqlite;

    const deadline = clock.currentTimeMillis() + busyTimeout;

    // A writer and a reader each own one connection; WAL lets the reader run beside the writer.
    const [client, reader] = await Promise.all(
      [0, 1].map(async () => {
        const connection = new DatabaseSync(file);

        connection.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
        connection.exec("PRAGMA synchronous = NORMAL");
        connection.exec("PRAGMA foreign_keys = ON");

        // On a file not yet in WAL the switch reads the header, then writes it. SQLite skips the
        // busy handler for that read-to-write step and fails at once while another connection
        // holds the write lock, so retry until busy_timeout has passed.
        while (true) {
          try {
            connection.exec("PRAGMA journal_mode = WAL");

            return connection;
          } catch (error) {
            const code = sqliteError.parse(error).errcode;

            if ((code & 0xff) !== 5 || clock.currentTimeMillis() >= deadline) throw error;

            await clock.sleep(
              Math.max(1, Math.min(50, deadline - clock.currentTimeMillis())),
              closing,
            );
          }
        }
      }),
    );

    if (!client || !reader) throw new Error("SQLite needs a write and a read connection");

    let tail: Promise<void> = Promise.resolve();

    const listeners = new Set<AbortController>();
    const ticks = new Set<AbortController>();

    const handle: Database.Handle = {
      client,
      reader,

      /**
       * One write transaction per process at a time: `node:sqlite` is synchronous, so two
       * sessions on one connection would mix statements. Waiters hand off in call order, and
       * a waiter that aborts keeps its place until the turn ahead of it ends.
       */
      async writeTurn(signal?: AbortSignal) {
        signal?.throwIfAborted();

        const ahead = tail;
        const held = Promise.withResolvers<void>();
        const turn = Promise.withResolvers<() => void>();

        tail = held.promise;

        // One decision per waiter: the first of the grant and the abort wins, so one holder.
        let waiting = true;

        // Named, so the turn can take it off the caller's signal again.
        const leave = () => {
          if (!waiting) return;

          waiting = false;

          // Keep this place in the queue until the turn ahead of it ends: the next waiter
          // waits on it, and the shared write connection is still inside that transaction.
          void ahead.then(() => held.resolve());

          turn.reject(signal?.reason);
        };

        void ahead.then(() => {
          // An abort that came first already handed this place on; a held turn ends with its session.
          if (!waiting) return;

          waiting = false;
          signal?.removeEventListener("abort", leave);

          turn.resolve(held.resolve);
        });

        signal?.addEventListener("abort", leave, { once: true });

        return turn.promise;
      },

      /** A commit in this process wakes every listener now, without waiting for the poll. */
      wake() {
        for (const tick of ticks) tick.abort(closing.reason);
      },

      async listen(
        channel: string,
        heard: (payload: string) => void,
        disconnected: () => void,
        signal?: AbortSignal,
      ) {
        const topic = channelName.parse(channel);

        signal?.throwIfAborted();

        const stop = new AbortController();

        const stopped = AbortSignal.any(
          signal ? [closing, stop.signal, signal] : [closing, stop.signal],
        );

        stopped.throwIfAborted();
        listeners.add(stop);

        let last = 0;

        try {
          // Start after what the channel already holds: a listener hears only later notifies.
          last = lastIdQuery.runSync(reader, { channel: topic }).id;
        } catch (error) {
          listeners.delete(stop);

          throw error;
        }

        queueMicrotask(async () => {
          try {
            while (!stopped.aborted) {
              const tick = new AbortController();

              const slept = clock.sleep(pollInterval, AbortSignal.any([stopped, tick.signal]));

              // Losing the race leaves this wait behind; it must not reject unhandled.
              slept.catch(() => {});

              ticks.add(tick);

              try {
                await slept;
              } catch {}

              ticks.delete(tick);

              if (stopped.aborted) return;

              for (const row of pollQuery.runSync(reader, { channel: topic, after: last })) {
                last = row.id;

                heard(row.payload);
              }
            }
          } catch {
            if (!stopped.aborted) disconnected();
          } finally {
            listeners.delete(stop);
          }
        });

        return stop.abort.bind(stop);
      },
    };

    defer(async () => {
      for (const stop of listeners) stop.abort(closing.reason);

      ticks.clear();
      client.close();
      reader.close();
    });

    // Keep the notify table small: rows past the retention are past every listener's start.
    queueMicrotask(async () => {
      while (!closing.aborted) {
        try {
          await clock.sleep(Math.max(1, Math.floor(retention / 2)), closing);
        } catch {
          return;
        }

        try {
          const release = await handle.writeTurn(closing);

          try {
            trimQuery.runSync(client, { before: clock.currentTimeMillis() - retention });
          } finally {
            release();
          }
        } catch (error) {
          if (closing.aborted) return;

          log.error("database.trimFailed", { error: String(error) });
        }
      }
    });

    return handle;
  },
});

export const migrate = operation({
  label: "migrate",
  depends: {
    file: databaseFile,
    sqlite,
    fs: sqliteFs,
    paths: sqlitePath,
    busyTimeout: databaseBusyTimeout,
    app: databaseFolder,
    folder: databaseMigrationsFolder,
    timeout: databaseMigrationTimeout,
  },
  run: async (
    { file, sqlite, fs, paths, busyTimeout, app, folder, timeout },
    { clock, defer, signal },
  ) => {
    const { DatabaseSync } = sqlite;
    const connection = new DatabaseSync(file);

    defer(() => connection.close());

    connection.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
    connection.exec("PRAGMA synchronous = NORMAL");
    connection.exec("PRAGMA foreign_keys = ON");

    const deadline = clock.currentTimeMillis() + timeout;

    // EXCLUSIVE stands in for the advisory lock: one process owns the schema at a time.
    // The WAL switch retries here too: on a fresh file SQLite fails its read-to-write step at
    // once, without busy_timeout, while another process holds the write lock.
    while (true) {
      signal.throwIfAborted();

      try {
        connection.exec("PRAGMA journal_mode = WAL");
        connection.exec("BEGIN EXCLUSIVE");

        break;
      } catch (error) {
        const code = sqliteError.parse(error).errcode;

        if ((code & 0xff) !== 5) throw error;

        if (clock.currentTimeMillis() >= deadline) throw fail("MigrationBusy", { timeout });

        await clock.sleep(Math.max(1, Math.min(50, deadline - clock.currentTimeMillis())), signal);
      }
    }

    // A file that fails, or a stop that lands between files, leaves nothing half applied.
    defer((end) => {
      if (end.status === "success") return;

      try {
        connection.exec("ROLLBACK");
      } catch {}
    });

    connection.exec(
      "CREATE TABLE IF NOT EXISTS start_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
    );

    const applied = new Set(
      connection
        .prepare("SELECT name FROM start_migrations")
        .all()
        .map((row) => row.name),
    );

    const record = connection.prepare(
      "INSERT INTO start_migrations (name, applied_at) VALUES (?, ?)",
    );

    // A relative folder resolves against the app folder, as the database file does.
    const source = paths.resolve(app ?? ".", folder);

    const names = (await fs.readdir(source)).filter(
      (name) => name.endsWith(".sql") && !applied.has(name),
    );

    for (const name of names.sort((left, right) => left.localeCompare(right))) {
      signal.throwIfAborted();

      connection.exec(await fs.readFile(paths.join(source, name), "utf8"));
      record.run(name, clock.currentTimeMillis());
    }

    connection.exec("COMMIT");
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
  depends: { database },
  factory: async (
    { database },
    { closing, clock, defer, signal },
  ): Promise<Database.SessionTransaction> => {
    // A call that stops before its first use must still leave the process's write turn.
    const stopped = AbortSignal.any([closing, signal]);

    let state: "idle" | "open" | "committed" | "rolledBack" = "idle";
    let starting: Promise<void> | undefined;
    let ending: Promise<void> | undefined;
    let release: (() => void) | undefined;
    let began = false;
    let notified = false;

    // The write connection, but a query after either end fails before it can reach SQLite.
    const guarded = new Proxy(database.client, {
      get(target, key) {
        if (key !== "prepare" && key !== "exec") {
          const value = Reflect.get(target, key, target);

          return typeof value === "function" ? value.bind(target) : value;
        }

        return function guardQuery(...args: unknown[]) {
          if (state === "committed" || state === "rolledBack") throw fail("TransactionEnded", {});

          return Reflect.apply(Reflect.get(target, key, target), target, args);
        };
      },
    });

    const tx: Database.SessionTransaction & { take(): Promise<DatabaseSync> } = {
      /** The lazy start: the first use takes the write turn, then opens the transaction. */
      async take() {
        if (state === "committed" || state === "rolledBack") throw fail("TransactionEnded", {});

        if (state === "idle") {
          state = "open";

          starting = Promise.resolve(database.writeTurn(stopped))
            .then((releaseTurn) => {
              release = releaseTurn;

              // The session ended while it waited: its end opened nothing, so this must not.
              if (state !== "open") throw fail("TransactionEnded", {});

              database.client.exec("BEGIN IMMEDIATE");

              began = true;
            })
            .catch((error) => {
              release?.();
              release = undefined;

              throw error;
            });
        }

        await starting;

        return guarded;
      },

      db: () => tx.take(),

      async notify(channel: string, payload: string) {
        const topic = channelName.parse(channel);

        const connection = await tx.take();

        notifyQuery.runSync(connection, {
          channel: topic,
          payload,
          created_at: clock.currentTimeMillis(),
        });

        notified = true;
      },

      transaction() {
        throw fail("NestedTransaction", {});
      },

      commit() {
        if (state === "committed" || state === "rolledBack") return Promise.resolve();

        const opened = state === "open";

        state = "committed";

        if (!opened) return Promise.resolve();

        // A start still waiting for the turn ends first; only a transaction it began is committed.
        ending = Promise.resolve(starting)
          .catch(() => {})
          .then(() => {
            if (!began) return;

            database.client.exec("COMMIT");

            if (notified) database.wake();
          })
          .catch((error) => {
            state = "rolledBack";

            try {
              database.client.exec("ROLLBACK");
            } catch {}

            throw error;
          })
          .finally(() => {
            release?.();
            release = undefined;
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
          .then(() => {
            if (began) database.client.exec("ROLLBACK");
          })
          .finally(() => {
            release?.();
            release = undefined;
          });

        void ending.catch(() => {});

        return ending;
      },
    };

    defer(async (end) => {
      try {
        if (state === "idle" || state === "open") {
          if (end.status === "success") await tx.commit();
          else await tx.rollback();
        }

        await ending;
      } finally {
        release?.();
        release = undefined;
      }
    });

    return tx;
  },
});
