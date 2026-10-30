import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createScope } from "@tinker/core";
import { afterEach, expect, test } from "vite-plus/test";

import {
  databaseBusyTimeout,
  databaseMigrationTimeout,
  databaseMigrationsFolder,
  databaseUrl,
  migrate,
} from "~/components/database-sqlite/index.server";

const app = fileURLToPath(new URL("..", import.meta.url));

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

/** A fresh temp home, its migrations folder, and the database file the scope opens. */
async function sandbox() {
  const home = await mkdtemp(join(tmpdir(), "tinker-sqlite-"));

  homes.push(home);

  const folder = join(home, "migrations");

  await mkdir(folder);

  return { folder, db: join(home, "app.db") };
}

function scopeFor(db: string, folder: string, timeout = 10_000) {
  return createScope({
    tags: [
      databaseUrl(pathToFileURL(db)),
      databaseMigrationsFolder(folder),
      databaseBusyTimeout(20),
      databaseMigrationTimeout(timeout),
    ],
  });
}

/** The real component's `migrate`, in a second OS process, through Vite's SSR loader. */
function spawnMigrate(db: string, folder: string) {
  const child = spawn(process.execPath, ["tests/support/sqlite-child.mjs"], {
    cwd: app,
    env: { ...process.env, SQLITE_CHILD: JSON.stringify({ action: "migrate", db, folder }) },
  });

  let stdout = "";

  let stderr = "";

  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));

  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function appliedRows(db: string) {
  const connection = new DatabaseSync(db);

  try {
    return connection
      .prepare("SELECT name, applied_at FROM start_migrations ORDER BY name")
      .all()
      .map((row) => ({ ...row }) as { name: string; applied_at: number });
  } finally {
    connection.close();
  }
}

test("migrate applies each file once, and a later run applies only the new file", async () => {
  const { folder, db } = await sandbox();

  await writeFile(
    join(folder, "20261028000001_first.sql"),
    "create table proof_first (id integer)",
  );
  await writeFile(
    join(folder, "20261028000002_second.sql"),
    "create table proof_second (id integer)",
  );

  const root = scopeFor(db, folder);

  await root.run(migrate);

  const first = appliedRows(db);

  expect(first.map((row) => row.name)).toEqual([
    "20261028000001_first.sql",
    "20261028000002_second.sql",
  ]);

  // A second run over the same files records nothing: a repeat insert would fail the primary key.
  await root.run(migrate);

  expect(appliedRows(db)).toEqual(first);

  await writeFile(
    join(folder, "20261028000003_third.sql"),
    "create table proof_third (id integer)",
  );

  await root.run(migrate);

  expect(appliedRows(db).map((row) => row.name)).toEqual([
    "20261028000001_first.sql",
    "20261028000002_second.sql",
    "20261028000003_third.sql",
  ]);

  await root.close({ graceful: true });
});

test("two OS processes migrating the same fresh file both succeed, recording each file once", async () => {
  const { folder, db } = await sandbox();

  await writeFile(
    join(folder, "20261028000001_first.sql"),
    "create table proof_first (id integer);\ncreate index proof_first_id on proof_first (id)",
  );
  await writeFile(
    join(folder, "20261028000002_second.sql"),
    "create table proof_second (id integer)",
  );

  const [first, second] = await Promise.all([spawnMigrate(db, folder), spawnMigrate(db, folder)]);

  expect(first.code, first.stderr).toBe(0);
  expect(second.code, second.stderr).toBe(0);

  const counted = new DatabaseSync(db);

  try {
    const rows = counted
      .prepare("SELECT name, count(*) AS n FROM start_migrations GROUP BY name ORDER BY name")
      .all()
      .map((row) => ({ ...row }) as { name: string; n: number });

    expect(rows).toEqual([
      { name: "20261028000001_first.sql", n: 1 },
      { name: "20261028000002_second.sql", n: 1 },
    ]);
  } finally {
    counted.close();
  }
});

test("migrate waits for another connection's schema lock and then ends as MigrationBusy", async () => {
  const { folder, db } = await sandbox();

  await writeFile(
    join(folder, "20261028000001_first.sql"),
    "create table proof_locked (id integer)",
  );

  const holder = new DatabaseSync(db);

  holder.exec("PRAGMA journal_mode = WAL");
  holder.exec("BEGIN EXCLUSIVE");

  const blocked = scopeFor(db, folder, 120);

  try {
    const result = await blocked.settle(migrate);

    expect(result).toMatchObject({
      status: "failed",
      error: { kind: "MigrationBusy", payload: { timeout: 120 } },
    });
  } finally {
    holder.exec("COMMIT");
    holder.close();

    await blocked.close({ graceful: true });
  }

  // The lock is gone: the same files apply, so the bounded wait was the only failure.
  const retried = scopeFor(db, folder);

  await retried.run(migrate);

  expect(appliedRows(db).map((row) => row.name)).toEqual(["20261028000001_first.sql"]);

  await retried.close({ graceful: true });
});
