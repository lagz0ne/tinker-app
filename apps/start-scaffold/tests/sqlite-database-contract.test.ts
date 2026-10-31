import { getEventListeners } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createScope, operation } from "@tinker/core";
import { makeTestClock, preset } from "@tinker/core/testing";
import { afterEach, expect, test } from "vite-plus/test";

import {
  database,
  databaseBusyTimeout,
  databaseFolder,
  databaseMigrationTimeout,
  databaseMigrationsFolder,
  databaseNotifyRetention,
  databasePollInterval,
  databaseSetup,
  databaseStop,
  databaseUrl,
  migrate,
  transaction,
} from "~/components/database-sqlite/index.server";
import { sqliteFs } from "~/components/database-sqlite/modules";

const app = fileURLToPath(new URL("..", import.meta.url));

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

type Logged = { message: string; attributes?: unknown };

/** A temp home with the shipped migration in its folder, and the file a scope opens. */
async function home() {
  const dir = await mkdtemp(join(tmpdir(), "tinker-sqlite-"));

  homes.push(dir);

  const folder = join(dir, "migrations");

  await mkdir(folder);

  await writeFile(
    join(folder, "20261028000000_start_notify.sql"),
    await readFile(join(app, "sqlite/migrations/20261028000000_start_notify.sql"), "utf8"),
  );

  return { folder, file: join(dir, "app.db") };
}

/** A scope over a temp database; migrated unless the proof needs the bare file. */
async function sandbox(
  options: { poll?: number; retention?: number; migrated?: boolean; logs?: Logged[] } = {},
) {
  const { folder, file } = await home();

  const root = createScope({
    observe: { log: (entry) => options.logs?.push(entry) },
    tags: [
      databaseUrl(pathToFileURL(file)),
      databaseMigrationsFolder(folder),
      databaseBusyTimeout(20),
      databaseMigrationTimeout(10_000),
      databasePollInterval(options.poll ?? 60_000),
      databaseNotifyRetention(options.retention ?? 600_000),
    ],
  });

  if (options.migrated ?? true) await root.run(migrate);

  return { root, file, folder };
}

/** Wait until `ready` holds, or fail here instead of at the test timeout. */
async function until(ready: () => boolean, ms = 4000) {
  const deadline = Date.now() + ms;

  while (Date.now() < deadline) {
    if (ready()) return;

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`not ready after ${ms}ms`);
}

const paused = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A turn the caller gets at once, or `"held"` when another holder still has it. */
function turnNow(db: { writeTurn(): Promise<() => void> }) {
  return Promise.race([
    db.writeTurn(),
    new Promise<"held">((resolve) => setTimeout(() => resolve("held"), 1000)),
  ]);
}

function pragma(connection: DatabaseSync, name: string) {
  return Object.values(connection.prepare(`PRAGMA ${name}`).get() ?? {})[0];
}

function insertQuiet(connection: DatabaseSync, channel: string, payload: string) {
  connection
    .prepare("INSERT INTO start_notify (channel, payload, created_at) VALUES (?, ?, ?)")
    .run(channel, payload, Date.now());
}

test("both owned connections open with WAL, NORMAL sync, the busy timeout, and foreign keys", async () => {
  // A bare file: WAL must come from the resource's own connections, not from a migrate run.
  const { root } = await sandbox({ migrated: false });

  const db = await root.resolve(database);

  for (const connection of [db.client, db.reader]) {
    expect(pragma(connection, "journal_mode")).toBe("wal");
    expect(pragma(connection, "busy_timeout")).toBe(20);
    expect(pragma(connection, "synchronous")).toBe(1);
    expect(pragma(connection, "foreign_keys")).toBe(1);
  }

  await root.close({ graceful: true });
});

test("closing the scope closes both owned connections", async () => {
  const { root } = await sandbox();

  const db = await root.resolve(database);

  expect([db.client.isOpen, db.reader.isOpen]).toEqual([true, true]);

  await root.close({ graceful: true });

  expect([db.client.isOpen, db.reader.isOpen]).toEqual([false, false]);
});

test("an aborted waiter takes its abort listener off the signal", async () => {
  const { root } = await sandbox();

  const db = await root.resolve(database);

  const release = await db.writeTurn();

  const stop = new AbortController();

  const waiting = db.writeTurn(stop.signal);

  stop.abort();

  await expect(waiting).rejects.toBe(stop.signal.reason);
  expect(getEventListeners(stop.signal, "abort")).toHaveLength(0);

  release();

  await root.close({ graceful: true });
});

test("a commit with no notify wakes no listener; a notifying commit wakes it", async () => {
  const { root } = await sandbox();

  const db = await root.resolve(database);

  const heard: string[] = [];

  const stop = await db.listen(
    "proof_quiet",
    (payload) => heard.push(payload),
    () => heard.push("disconnected"),
  );

  // A row with no wake: with a 60s poll, only a wake makes the listener read it.
  insertQuiet(db.client, "proof_quiet", "unpolled");

  const plain = operation({
    label: "proof.sqlitePlainCommit",
    depends: { tx: transaction },
    run: async ({ tx }) => {
      (await tx.db()).prepare("SELECT 1").get();
    },
  });

  expect(await root.settle(plain, { signal: new AbortController().signal })).toMatchObject({
    status: "success",
  });

  await paused(100);
  expect(heard).toEqual([]);

  const loud = operation({
    label: "proof.sqliteLoudCommit",
    depends: { tx: transaction },
    run: async ({ tx }) => {
      await tx.notify("proof_quiet", "woken");
    },
  });

  await root.settle(loud, { signal: new AbortController().signal });
  await until(() => heard.length >= 2, 10_000).catch(() => {});

  expect(heard).toEqual(["unpolled", "woken"]);

  stop();

  await root.close({ graceful: true });
});

test("a stopped listener reads no more rows, even ones waiting for its next poll", async () => {
  const { root } = await sandbox();

  const db = await root.resolve(database);

  const heard: string[] = [];

  const stop = await db.listen(
    "proof_stop_poll",
    (payload) => heard.push(payload),
    () => heard.push("disconnected"),
  );

  insertQuiet(db.client, "proof_stop_poll", "after stop");

  stop();

  await paused(100);
  expect(heard).toEqual([]);

  await root.close({ graceful: true });
});

test("a poll that fails tells the listener it is disconnected, once", async () => {
  const { root } = await sandbox();

  const db = await root.resolve(database);

  const heard: string[] = [];

  const lost: string[] = [];

  const stop = await db.listen(
    "proof_lost",
    (payload) => heard.push(payload),
    () => lost.push("disconnected"),
  );

  db.client.exec("DROP TABLE start_notify");
  db.wake();

  await until(() => lost.length > 0);
  await paused(100);

  expect({ heard, lost }).toEqual({ heard: [], lost: ["disconnected"] });

  stop();

  await root.close({ graceful: true });
});

test("a listener left open at close ends without a disconnect", async () => {
  const { root } = await sandbox({ poll: 20 });

  const db = await root.resolve(database);

  const lost: string[] = [];

  await db.listen(
    "proof_open_at_close",
    () => {},
    () => lost.push("disconnected"),
  );

  await root.close({ graceful: true });
  await paused(100);

  expect(lost).toEqual([]);
});

test("a listener whose start read fails rejects instead of polling a broken channel", async () => {
  // No migrate: the notify table is missing, so the listener's start read fails.
  const { root } = await sandbox({ migrated: false });

  const db = await root.resolve(database);

  const lost: string[] = [];

  await expect(
    db.listen(
      "proof_no_table",
      () => {},
      () => lost.push("disconnected"),
    ),
  ).rejects.toThrow(/no such table/);

  db.wake();
  await paused(100);

  expect(lost).toEqual([]);

  await root.close({ graceful: true });
});

test("a listen call after the database closed is refused before it reads", async () => {
  const { root } = await sandbox();

  const db = await root.resolve(database);

  await root.close({ graceful: true });

  const refused = await db
    .listen(
      "proof_closed",
      () => {},
      () => {},
    )
    .then(
      () => "listening",
      (error: unknown) => error,
    );

  // The closed scope's own stop, not SQLite's error about a closed connection.
  expect(String(refused)).not.toMatch(/not open/);
  expect(refused).not.toBe("listening");
});

test("the trim hands the write turn back after each pass", async () => {
  const { root } = await sandbox({ retention: 100 });

  const db = await root.resolve(database);

  db.client
    .prepare("INSERT INTO start_notify (channel, payload, created_at) VALUES (?, ?, ?)")
    .run("proof_trim_turn", "stale", Date.now() - 60_000);

  await until(() => db.reader.prepare("SELECT * FROM start_notify").all().length === 0);

  const next = await turnNow(db);

  expect(next).toBeTypeOf("function");

  if (typeof next === "function") next();

  await root.close({ graceful: true });
});

test("a failed trim is logged and the trim keeps running", async () => {
  const logs: Logged[] = [];

  const { root } = await sandbox({ retention: 100, logs });

  const db = await root.resolve(database);

  db.client.exec("DROP TABLE start_notify");

  await until(() => logs.filter((entry) => entry.message === "database.trimFailed").length >= 2);

  await root.close({ graceful: true });
});

test("a trim waiting for the turn when the scope closes ends without a failure log", async () => {
  const logs: Logged[] = [];

  const { root } = await sandbox({ retention: 100, logs });

  const db = await root.resolve(database);

  // Hold the turn so the trim's next pass waits for it, then close under it.
  const release = await db.writeTurn();

  await paused(150);
  await root.close({ graceful: true });
  await paused(50);

  release();

  expect(logs.filter((entry) => entry.message === "database.trimFailed")).toEqual([]);
});

test("migrate leaves the file in WAL and closes its own connection", async () => {
  const { root, file } = await sandbox();

  // WAL is a file setting; closing the last connection checkpoints and removes the -wal file.
  const raw = new DatabaseSync(file);

  try {
    expect(pragma(raw, "journal_mode")).toBe("wal");
  } finally {
    raw.close();
  }

  expect(existsSync(`${file}-wal`)).toBe(false);

  await root.close({ graceful: true });
});

test("migrate enforces foreign keys inside a migration file", async () => {
  const { folder, file } = await home();

  await writeFile(
    join(folder, "20261028000001_orphan.sql"),
    [
      "create table proof_parent (id integer primary key);",
      "create table proof_child (parent_id integer not null references proof_parent (id));",
      "insert into proof_child (parent_id) values (7);",
    ].join("\n"),
  );

  const root = createScope({
    tags: [databaseUrl(pathToFileURL(file)), databaseMigrationsFolder(folder)],
  });

  const result = await root.settle(migrate);

  expect(result).toMatchObject({ status: "failed" });
  expect(String(result.status === "failed" ? result.error : "")).toMatch(/FOREIGN KEY/);

  // The failed file rolled back with the files before it.
  const raw = new DatabaseSync(file);

  try {
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
  } finally {
    raw.close();
  }

  await root.close({ graceful: true });
});

test("migrate waits on SQLite's busy timeout for each lock attempt", async () => {
  const { folder, file } = await home();

  const holder = new DatabaseSync(file);

  holder.exec("PRAGMA journal_mode = WAL");
  holder.exec("BEGIN EXCLUSIVE");

  const clock = makeTestClock();

  const root = createScope({
    startTimeout: 0,
    clock: {
      ...clock,
      async sleep(ms) {
        clock.advance(ms);
      },
    },
    tags: [
      databaseUrl(pathToFileURL(file)),
      databaseMigrationsFolder(folder),
      databaseBusyTimeout(100),
      databaseMigrationTimeout(120),
    ],
  });

  const started = Date.now();

  try {
    expect(await root.settle(migrate)).toMatchObject({
      status: "failed",
      error: { kind: "MigrationBusy" },
    });

    // Four attempts (0, 50, 100, 120 ms of virtual time), each held 100 ms by SQLite itself.
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  } finally {
    holder.exec("COMMIT");
    holder.close();

    await root.close({ graceful: true });
  }
});

test("migrate retries the schema lock until its deadline, in steps of at most 50 ms", async () => {
  const { folder, file } = await home();

  const holder = new DatabaseSync(file);

  holder.exec("PRAGMA journal_mode = WAL");
  holder.exec("BEGIN EXCLUSIVE");

  const clock = makeTestClock({ now: 1_000_000 });

  const sleeps: number[] = [];

  let attempts = 0;

  const root = createScope({
    startTimeout: 0,
    clock: {
      ...clock,
      async sleep(ms) {
        sleeps.push(ms);
        attempts += 1;

        // The other holder lets go on the fourth wait: the next attempt owns the schema.
        if (attempts === 4) holder.exec("COMMIT");

        clock.advance(ms);
      },
    },
    tags: [
      databaseUrl(pathToFileURL(file)),
      databaseMigrationsFolder(folder),
      databaseBusyTimeout(0),
      databaseMigrationTimeout(1000),
    ],
  });

  try {
    expect(await root.settle(migrate)).toMatchObject({ status: "success" });
    expect(sleeps).toEqual([50, 50, 50, 50]);
  } finally {
    if (holder.isTransaction) holder.exec("COMMIT");

    holder.close();

    await root.close({ graceful: true });
  }

  const short = await home();

  const blocker = new DatabaseSync(short.file);

  blocker.exec("PRAGMA journal_mode = WAL");
  blocker.exec("BEGIN EXCLUSIVE");

  const shortClock = makeTestClock({ now: 1_000_000 });

  const shortSleeps: number[] = [];

  const bounded = createScope({
    startTimeout: 0,
    clock: {
      ...shortClock,
      async sleep(ms) {
        shortSleeps.push(ms);
        shortClock.advance(ms);
      },
    },
    tags: [
      databaseUrl(pathToFileURL(short.file)),
      databaseMigrationsFolder(short.folder),
      databaseBusyTimeout(0),
      databaseMigrationTimeout(120),
    ],
  });

  try {
    expect(await bounded.settle(migrate)).toMatchObject({
      status: "failed",
      error: { kind: "MigrationBusy", payload: { timeout: 120 } },
    });

    // The last wait stops at the deadline instead of a full step past it.
    expect(shortSleeps).toEqual([50, 50, 20]);
  } finally {
    blocker.exec("COMMIT");
    blocker.close();

    await bounded.close({ graceful: true });
  }
});

// SQLite skips the busy handler when a connection that holds a read lock asks for a write lock:
// it returns SQLITE_BUSY at once, to avoid a deadlock (sqlite3_busy_handler docs). On a file not
// yet in WAL, `PRAGMA journal_mode = WAL` reads the header, then writes it in that same way.
test("migrate on a fresh file retries the WAL switch while another connection holds the write lock", async () => {
  const { folder, file } = await home();

  // A fresh file in rollback mode; its RESERVED lock lets the switch read but not write.
  const holder = new DatabaseSync(file);

  holder.exec("BEGIN IMMEDIATE");

  const clock = makeTestClock({ now: 1_000_000 });

  const sleeps: number[] = [];

  const root = createScope({
    startTimeout: 0,
    clock: {
      ...clock,
      async sleep(ms) {
        sleeps.push(ms);

        // The other writer commits during the first wait; the next attempt switches the file.
        if (holder.isTransaction) holder.exec("COMMIT");

        clock.advance(ms);
      },
    },
    tags: [
      databaseUrl(pathToFileURL(file)),
      databaseMigrationsFolder(folder),
      databaseBusyTimeout(5000),
      databaseMigrationTimeout(1000),
    ],
  });

  try {
    expect(await root.settle(migrate)).toMatchObject({ status: "success" });
    expect(sleeps).toEqual([50]);
  } finally {
    if (holder.isTransaction) holder.exec("COMMIT");

    holder.close();

    await root.close({ graceful: true });
  }

  const raw = new DatabaseSync(file);

  try {
    expect(pragma(raw, "journal_mode")).toBe("wal");
    expect(
      raw
        .prepare("SELECT name FROM start_migrations")
        .all()
        .map((row) => row.name),
    ).toEqual(["20261028000000_start_notify.sql"]);
  } finally {
    raw.close();
  }
});

test("the database opens a fresh file while another connection holds the write lock", async () => {
  const { file } = await home();

  const holder = new DatabaseSync(file);

  holder.exec("BEGIN IMMEDIATE");

  const clock = makeTestClock({ now: 1_000_000 });

  const waits: number[] = [];

  const root = createScope({
    clock: {
      ...clock,
      sleep(ms, signal) {
        // The trim timer's long wait stays on the test clock; only the open's retry is short.
        if (ms > 50) return clock.sleep(ms, signal);

        waits.push(ms);

        if (holder.isTransaction) holder.exec("COMMIT");

        clock.advance(ms);

        return Promise.resolve();
      },
    },
    tags: [databaseUrl(pathToFileURL(file)), databaseBusyTimeout(5000)],
  });

  try {
    const db = await root.resolve(database);

    expect(waits).toEqual([50]);

    for (const connection of [db.client, db.reader]) {
      expect(pragma(connection, "journal_mode")).toBe("wal");
    }
  } finally {
    if (holder.isTransaction) holder.exec("COMMIT");

    holder.close();

    await root.close({ graceful: true });
  }
});

test("a stop that lands between migration files applies none of them", async () => {
  const { folder, file } = await home();

  await writeFile(join(folder, "20261028000001_second.sql"), "create table proof_second (id int)");

  const stop = new AbortController();

  const real = await import("node:fs/promises");

  // The stop arrives while the first file is read; the loop must refuse the next file.
  const fs = new Proxy(real, {
    get(target, key) {
      if (key === "readFile") stop.abort(new Error("stopped between files"));

      return Reflect.get(target, key);
    },
  });

  const root = createScope({
    tags: [databaseUrl(pathToFileURL(file)), databaseMigrationsFolder(folder)],
    presets: [preset(sqliteFs, async () => fs)],
  });

  const result = await root.settle(migrate, { signal: stop.signal });

  expect(result.status).not.toBe("success");

  const raw = new DatabaseSync(file);

  try {
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
  } finally {
    raw.close();
  }

  await root.close({ graceful: true });
});

test("database setup migrates before ready, and its stop signal reaches the migration", async () => {
  const { folder, file } = await home();

  const root = createScope({
    extensions: [databaseSetup],
    tags: [databaseUrl(pathToFileURL(file)), databaseMigrationsFolder(folder)],
  });

  await root.ready;

  const db = await root.resolve(database);

  expect(
    db.reader
      .prepare("SELECT name FROM start_migrations")
      .all()
      .map((row) => row.name),
  ).toEqual(["20261028000000_start_notify.sql"]);

  await root.close({ graceful: true });

  const other = await home();

  const stop = new AbortController();

  stop.abort(new Error("worker stopped"));

  const stopped = createScope({
    extensions: [databaseSetup],
    tags: [
      databaseUrl(pathToFileURL(other.file)),
      databaseMigrationsFolder(other.folder),
      databaseStop(stop.signal),
    ],
  });

  await expect(stopped.ready).rejects.toBeDefined();

  const raw = new DatabaseSync(other.file);

  try {
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
  } finally {
    raw.close();
  }

  await stopped.close({ graceful: true });
});

test("the connection a rolled-back session handed out refuses its own queries", async () => {
  const { root } = await sandbox();

  const refused: string[] = [];

  const call = operation({
    label: "proof.sqliteRolledBackView",
    depends: { tx: transaction },
    run: async ({ tx }) => {
      const connection = await tx.db();

      await tx.rollback();

      for (const query of [
        () => connection.prepare("SELECT 1"),
        () => connection.exec("SELECT 1"),
      ]) {
        try {
          query();
        } catch (error) {
          refused.push(String((error as Error & { kind?: string }).kind));
        }
      }

      return "done";
    },
  });

  expect(await root.settle(call, { signal: new AbortController().signal })).toMatchObject({
    status: "success",
  });
  expect(refused).toEqual(["TransactionEnded", "TransactionEnded"]);

  await root.close({ graceful: true });
});

test("a session whose COMMIT failed refuses later use with TransactionEnded", async () => {
  const { root, folder } = await sandbox({ migrated: false });

  await writeFile(
    join(folder, "20261028000001_deferred.sql"),
    "create table proof_parent (id integer primary key);\ncreate table proof_child (parent_id integer references proof_parent (id))",
  );

  await root.run(migrate);

  const outcome: string[] = [];

  const call = operation({
    label: "proof.sqliteAfterFailedCommit",
    depends: { tx: transaction },
    run: async ({ tx }) => {
      const connection = await tx.db();

      connection.exec("PRAGMA defer_foreign_keys = ON");
      connection.prepare("INSERT INTO proof_child (parent_id) VALUES (?)").run(99);

      await tx.commit().then(
        () => outcome.push("committed"),
        () => outcome.push("commit failed"),
      );

      await tx.db().then(
        () => outcome.push("usable"),
        (error: Error & { kind?: string }) => outcome.push(String(error.kind)),
      );
    },
  });

  await root.settle(call, { signal: new AbortController().signal });

  expect(outcome).toEqual(["commit failed", "TransactionEnded"]);

  const db = await root.resolve(database);

  expect(db.client.isTransaction).toBe(false);

  await root.close({ graceful: true });
});

test("an explicit commit or rollback hands the write turn back before the call ends", async () => {
  const { root } = await sandbox();

  const db = await root.resolve(database);

  for (const end of ["commit", "rollback"] as const) {
    const seen: unknown[] = [];

    const call = operation({
      label: `proof.sqliteTurnAfter${end}`,
      depends: { tx: transaction },
      run: async ({ tx }) => {
        await tx.notify("proof", end);
        await tx[end]();

        // The session is still running, yet another writer gets the turn at once.
        const next = await turnNow(db);

        seen.push(typeof next);

        if (typeof next === "function") next();
      },
    });

    expect(await root.settle(call, { signal: new AbortController().signal })).toMatchObject({
      status: "success",
    });
    expect(seen).toEqual(["function"]);
  }

  await root.close({ graceful: true });
});

test("a commit that overtakes a waiting first use resolves and opens nothing", async () => {
  const { root } = await sandbox();

  const db = await root.resolve(database);

  const release = await db.writeTurn();

  const ended = Promise.withResolvers<void>();

  const early = operation({
    label: "proof.sqliteCommitWhileWaiting",
    depends: { tx: transaction },
    run: async ({ tx }) => {
      const pending = tx.db();

      pending.catch(() => {});

      const committed = tx.commit();

      ended.resolve();

      await committed;

      return pending.then(
        () => "opened",
        (error: Error & { kind?: string }) => String(error.kind),
      );
    },
  });

  const running = root.settle(early, { signal: new AbortController().signal });

  await ended.promise;
  release();

  expect(await running).toMatchObject({ status: "success", value: "TransactionEnded" });
  expect(db.client.isTransaction).toBe(false);

  await root.close({ graceful: true });
});

/** A temp app folder that holds the `data` folder a relative URL names, and one migration. */
async function appFolder() {
  const dir = await mkdtemp(join(tmpdir(), "tinker-sqlite-"));

  homes.push(dir);

  await mkdir(join(dir, "data"));
  await mkdir(join(dir, "migrations"));

  await writeFile(
    join(dir, "migrations", "20261028000000_proof.sql"),
    "create table proof_relative (id integer)",
  );

  return dir;
}

function startRows(file: string) {
  const connection = new DatabaseSync(file);

  try {
    return connection
      .prepare("SELECT name FROM start_migrations ORDER BY name")
      .all()
      .map((row) => row.name);
  } finally {
    connection.close();
  }
}

test("a relative database URL string resolves against the app folder, not the disk root", async () => {
  const folder = await appFolder();

  const root = createScope({
    tags: [databaseUrl("file:./data/app.db"), databaseFolder(folder), databaseBusyTimeout(20)],
  });

  expect(await root.settle(migrate)).toMatchObject({ status: "success" });

  expect(existsSync(join(folder, "data", "app.db")), "inside the app folder").toBe(true);
  expect(existsSync("/data/app.db"), "never at the disk root").toBe(false);

  await root.close({ graceful: true });
});

test("plain path, file: path, and file: ./ path strings all land in the app folder", async () => {
  for (const raw of ["file:./data/app.db", "data/app.db", "file:data/app.db"]) {
    const folder = await appFolder();

    const root = createScope({
      tags: [databaseUrl(raw), databaseFolder(folder), databaseBusyTimeout(20)],
    });

    expect(await root.settle(migrate)).toMatchObject({ status: "success" });

    expect(existsSync(join(folder, "data", "app.db")), raw).toBe(true);

    await root.close({ graceful: true });
  }
});

test("a folder name with percent, hash, and question mark keeps the file inside it", async () => {
  const parent = await mkdtemp(join(tmpdir(), "tinker-sqlite-"));

  homes.push(parent);

  const folder = join(parent, "a%b#c?d");

  await mkdir(join(folder, "data"), { recursive: true });
  await mkdir(join(folder, "migrations"));

  const root = createScope({
    tags: [databaseUrl("file:./data/app.db"), databaseFolder(folder), databaseBusyTimeout(20)],
  });

  expect(await root.settle(migrate)).toMatchObject({ status: "success" });

  expect(existsSync(join(folder, "data", "app.db"))).toBe(true);

  await root.close({ graceful: true });
});

test("an absolute file URL ignores the app folder", async () => {
  const { file } = await home();

  const folder = await appFolder();

  const root = createScope({
    tags: [databaseUrl(pathToFileURL(file)), databaseFolder(folder), databaseBusyTimeout(20)],
  });

  expect(await root.settle(migrate)).toMatchObject({ status: "success" });

  expect(existsSync(file), "the file the URL names").toBe(true);
  expect(existsSync(join(folder, "data", "app.db")), "nothing in the app folder").toBe(false);
  expect(existsSync(join(folder, "app.db")), "nothing in the app folder").toBe(false);

  await root.close({ graceful: true });
});

test("an absolute file URL string ignores the app folder", async () => {
  const { file } = await home();

  const folder = await appFolder();

  const root = createScope({
    tags: [databaseUrl(pathToFileURL(file).href), databaseFolder(folder), databaseBusyTimeout(20)],
  });

  expect(await root.settle(migrate)).toMatchObject({ status: "success" });

  expect(existsSync(file), "the file the URL names").toBe(true);
  expect(existsSync(join(folder, "data", "app.db")), "nothing in the app folder").toBe(false);

  await root.close({ graceful: true });
});

test("a non-file or empty database value is refused before any file opens", async () => {
  const folder = await appFolder();

  for (const refused of ["postgres://u:p@h/db", new URL("postgres://u:p@h/db"), ""]) {
    expect(
      () => databaseUrl(refused as unknown as URL | string),
      `refused: ${JSON.stringify(String(refused))}`,
    ).toThrow(
      expect.objectContaining({
        kind: "DataValidationFailed",
        payload: expect.objectContaining({ label: "database.url" }),
      }),
    );
  }

  // The refusal lands on the binding, so no scope holds a value that could open a file.
  expect(existsSync(join(folder, "data", "app.db")), "no file was created").toBe(false);
  expect(existsSync(folder), "the app folder itself is untouched").toBe(true);
});

test("a relative database URL string with no app folder fails loud", async () => {
  const root = createScope({ tags: [databaseUrl("file:./data/app.db")] });

  expect(await root.settle(migrate)).toMatchObject({
    status: "failed",
    error: { kind: "DatabaseFolderMissing" },
  });

  expect(existsSync("/data/app.db"), "never the disk-root file").toBe(false);

  await root.close({ graceful: true });
});

test("a relative migrations folder resolves against the app folder, not the working directory", async () => {
  const folder = await appFolder();

  const root = createScope({
    tags: [databaseUrl("file:./data/app.db"), databaseFolder(folder), databaseBusyTimeout(20)],
  });

  expect(await root.settle(migrate)).toMatchObject({ status: "success" });

  expect(startRows(join(folder, "data", "app.db"))).toEqual(["20261028000000_proof.sql"]);

  await root.close({ graceful: true });
});
