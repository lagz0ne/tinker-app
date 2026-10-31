import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

/** The app folder: this file lives in `maintain/`. */
const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Rebuild the SQLite dev database that the Reylo type check and the `.sql` imports read. */
export async function buildDevDatabase() {
  await requireMapper();

  const file = join(app, ".tinker", "sqlite-dev.db");

  // The SQLite components ship their migrations to `sqlite/migrations`; an older app may use `migrations`.
  const folders = [join(app, "sqlite", "migrations"), join(app, "migrations")];

  let folder = folders[0];

  let names = [];

  for (const candidate of folders) {
    names = (await readdir(candidate).catch(() => [])).filter((name) => name.endsWith(".sql"));

    if (names.length > 0) {
      folder = candidate;

      break;
    }
  }

  await mkdir(dirname(file), { recursive: true });

  for (const suffix of ["", "-wal", "-shm"]) await rm(file + suffix, { force: true });

  const db = new DatabaseSync(file);

  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  // The same bookkeeping table the `migrate` operation creates before it applies files.
  db.exec(
    "CREATE TABLE IF NOT EXISTS start_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );

  for (const name of names.sort((left, right) => left.localeCompare(right))) {
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
}

/**
 * Stop when the app holds the SQLite set but its tsconfig.json has no Reylo content mapper. Then
 * tsc reads each `.sql` import through `database-sqlite/sql.d.ts` (any params and rows) and
 * passes, so a missed `contentMappers` paste would hide every query type. The type check and
 * the tests run this script first, so they fail here instead.
 */
async function requireMapper() {
  const installed = await readdir(join(app, "tinker", "components", "database-sqlite")).catch(
    () => null,
  );
  if (installed === null) return;

  if (/"contentMappers"[\s\S]*"reylo"/.test(await nearestConfig(app))) return;

  throw new Error(
    'sqlite dev db: tsconfig.json has no Reylo "contentMappers" entry; paste the tsconfig.json line tinker add printed',
  );
}

/**
 * The tsconfig.json tsc and Vite read for the app: the nearest one at or above its folder. A
 * Stryker sandbox copies the app without its tsconfig.json, so there it is the app's own, above.
 * @param {string} folder - From the app folder; why: where the lookup starts.
 */
async function nearestConfig(folder) {
  for (let dir = folder; ; dir = dirname(dir)) {
    const config = await readFile(join(dir, "tsconfig.json"), "utf8").catch(() => null);
    if (config !== null) return config;
    if (dirname(dir) === dir) return "";
  }
}

export default buildDevDatabase;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildDevDatabase();
}
