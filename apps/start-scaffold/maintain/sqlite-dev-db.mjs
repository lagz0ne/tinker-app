import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Rebuild the SQLite dev database that the Reylo type check and `.sql` imports read. */
const app = resolve(import.meta.dirname, "..");

const file = join(app, ".tinker", "sqlite-dev.db");

const folder = join(app, "sqlite", "migrations");

await mkdir(dirname(file), { recursive: true });

for (const suffix of ["", "-wal", "-shm"]) await rm(file + suffix, { force: true });

const db = new DatabaseSync(file);

db.exec("PRAGMA journal_mode = WAL");

db.exec("PRAGMA foreign_keys = ON");

// The same bookkeeping table the `migrate` operation creates before it applies files.
db.exec(
  "CREATE TABLE IF NOT EXISTS start_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
);

const names = (await readdir(folder).catch(() => [])).filter((name) => name.endsWith(".sql"));

for (const name of names.sort()) {
  db.exec("BEGIN EXCLUSIVE");

  try {
    db.exec(await readFile(join(folder, name), "utf8"));

    db.prepare("INSERT INTO start_migrations (name, applied_at) VALUES (?, ?)").run(
      name,
      Date.now(),
    );

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");

    throw error;
  }
}

db.close();

console.log(`sqlite dev db: ${names.length} migrations applied to .tinker/sqlite-dev.db`);
