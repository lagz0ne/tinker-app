import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createScope, operation } from "@tinker/core";
import { afterEach, expect, test } from "vite-plus/test";

import {
  database,
  databaseBusyTimeout,
  databaseMigrationTimeout,
  databaseMigrationsFolder,
  databaseNotifyRetention,
  databasePollInterval,
  databaseUrl,
  migrate,
  transaction,
} from "~/components/database-sqlite/index.server";

const app = fileURLToPath(new URL("..", import.meta.url));

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

/** A migrated temp database with a poll interval and retention the proof can wait on. */
async function sandbox(options: { poll?: number; retention?: number } = {}) {
  const home = await mkdtemp(join(tmpdir(), "tinker-sqlite-"));

  homes.push(home);

  const folder = join(home, "migrations");

  await mkdir(folder);

  await writeFile(
    join(folder, "20261028000000_start_notify.sql"),
    await readFile(join(app, "sqlite/migrations/20261028000000_start_notify.sql"), "utf8"),
  );

  const root = createScope({
    tags: [
      databaseUrl(pathToFileURL(join(home, "app.db"))),
      databaseMigrationsFolder(folder),
      databaseBusyTimeout(20),
      databaseMigrationTimeout(10_000),
      databasePollInterval(options.poll ?? 40),
      databaseNotifyRetention(options.retention ?? 600_000),
    ],
  });

  await root.run(migrate);

  return root;
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

/** The real component's notify session, in a second OS process, through Vite's SSR loader. */
function spawnNotify(db: string, channel: string, payload: string) {
  const child = spawn(process.execPath, ["tests/support/sqlite-child.mjs"], {
    cwd: app,
    env: {
      ...process.env,
      SQLITE_CHILD: JSON.stringify({ action: "notify", db, channel, payload }),
    },
  });

  let stderr = "";

  child.stderr.on("data", (chunk) => (stderr += chunk));

  return new Promise<string>((resolve, reject) => {
    child.on("close", (code) => (code === 0 ? resolve(stderr) : reject(new Error(stderr))));
  });
}

test("a listener hears its own process's commit at once, without waiting for a poll", async () => {
  const root = await sandbox({ poll: 60_000 });

  const db = await root.resolve(database);

  const heard: string[] = [];

  const lost: string[] = [];

  const stop = await db.listen(
    "proof_same",
    (payload) => heard.push(payload),
    () => lost.push("disconnected"),
  );

  const save = operation({
    label: "proof.sqliteNotify",
    depends: { tx: transaction },
    run: async ({ tx }) => {
      await tx.notify("proof_same", "wake");
    },
  });

  await root.settle(save, { signal: new AbortController().signal });
  await until(() => heard.length === 1);

  expect(heard).toEqual(["wake"]);
  expect(lost).toEqual([]);

  stop();

  await root.close({ graceful: true });
});

test("a rolled-back notify is never heard", async () => {
  const root = await sandbox({ poll: 40 });

  const db = await root.resolve(database);

  const heard: string[] = [];

  const stop = await db.listen(
    "proof_rolled_back",
    (payload) => heard.push(payload),
    () => heard.push("disconnected"),
  );

  const refused = operation({
    label: "proof.sqliteRefusedNotify",
    depends: { tx: transaction },
    run: async ({ tx }, { raise }) => {
      await tx.notify("proof_rolled_back", "dropped");

      raise("StepRefused", {});
    },
  });

  await root.settle(refused, { signal: new AbortController().signal });

  // Several poll intervals, so an unhidden row would have arrived by now.
  await paused(200);

  expect(heard).toEqual([]);

  stop();

  await root.close({ graceful: true });
});

test("a listener starts after the rows a channel already holds", async () => {
  const root = await sandbox({ poll: 40 });

  const db = await root.resolve(database);

  const older = operation({
    label: "proof.sqliteOlder",
    depends: { tx: transaction },
    run: async ({ tx }) => {
      await tx.notify("proof_history", "older");
    },
  });

  await root.settle(older, { signal: new AbortController().signal });

  const heard: string[] = [];

  const stop = await db.listen(
    "proof_history",
    (payload) => heard.push(payload),
    () => heard.push("disconnected"),
  );

  const newer = operation({
    label: "proof.sqliteNewer",
    depends: { tx: transaction },
    run: async ({ tx }) => {
      await tx.notify("proof_history", "newer");
    },
  });

  await root.settle(newer, { signal: new AbortController().signal });
  await until(() => heard.length === 1);

  expect(heard).toEqual(["newer"]);

  stop();

  await root.close({ graceful: true });
});

test("a listener hears a notify that another OS process committed", async () => {
  const home = await mkdtemp(join(tmpdir(), "tinker-sqlite-"));

  homes.push(home);

  const folder = join(home, "migrations");

  await mkdir(folder);

  await writeFile(
    join(folder, "20261028000000_start_notify.sql"),
    await readFile(join(app, "sqlite/migrations/20261028000000_start_notify.sql"), "utf8"),
  );

  const file = join(home, "app.db");

  const root = createScope({
    tags: [
      databaseUrl(pathToFileURL(file)),
      databaseMigrationsFolder(folder),
      databaseBusyTimeout(20),
      databaseMigrationTimeout(10_000),
      databasePollInterval(40),
      databaseNotifyRetention(600_000),
    ],
  });

  await root.run(migrate);

  const db = await root.resolve(database);

  const heard: string[] = [];

  const stop = await db.listen(
    "proof_other_process",
    (payload) => heard.push(payload),
    () => heard.push("disconnected"),
  );

  await spawnNotify(file, "proof_other_process", "from another process");
  await until(() => heard.length === 1);

  expect(heard).toEqual(["from another process"]);

  stop();

  await root.close({ graceful: true });
});

test("stop and a caller's abort both end delivery", async () => {
  const root = await sandbox({ poll: 40 });

  const db = await root.resolve(database);

  const heard: string[] = [];

  const stop = await db.listen(
    "proof_stopped",
    (payload) => heard.push(payload),
    () => heard.push("disconnected"),
  );

  stop();

  const caller = new AbortController();

  const aborted = await db.listen(
    "proof_aborted",
    (payload) => heard.push(payload),
    () => heard.push("disconnected"),
    caller.signal,
  );

  caller.abort();

  const save = operation({
    label: "proof.sqliteAfterStop",
    depends: { tx: transaction },
    run: async ({ tx }) => {
      await tx.notify("proof_stopped", "missed");
      await tx.notify("proof_aborted", "missed");
    },
  });

  await root.settle(save, { signal: new AbortController().signal });
  await paused(200);

  expect(heard).toEqual([]);

  aborted();

  await root.close({ graceful: true });
});

test("notify rows past the retention are trimmed", async () => {
  const root = await sandbox({ poll: 40, retention: 100 });

  const db = await root.resolve(database);

  const old = Date.now() - 60_000;

  db.client
    .prepare("INSERT INTO start_notify (channel, payload, created_at) VALUES (?, ?, ?)")
    .run("proof_trim", "stale", old);

  const fresh = operation({
    label: "proof.sqliteFresh",
    depends: { tx: transaction },
    run: async ({ tx }) => {
      await tx.notify("proof_trim", "fresh");
    },
  });

  await root.settle(fresh, { signal: new AbortController().signal });
  await until(
    () =>
      db.reader.prepare("SELECT * FROM start_notify WHERE payload = 'stale'").all().length === 0,
  );

  expect(
    db.reader
      .prepare("SELECT payload FROM start_notify ORDER BY id")
      .all()
      .map((row) => String(row.payload)),
  ).toEqual(["fresh"]);

  await root.close({ graceful: true });
});

test("a channel name outside the shared pattern is refused", async () => {
  const root = await sandbox();

  const db = await root.resolve(database);

  await expect(
    db.listen(
      "Proof Bad",
      () => {},
      () => {},
    ),
  ).rejects.toThrow();

  await root.close({ graceful: true });
});
