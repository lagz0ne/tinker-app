import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const app = resolve(import.meta.dirname, "..");
const consumer = await mkdtemp(join(tmpdir(), "start-seam-schema-"));
async function inventory(folder) {
  const entries = await readdir(folder, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    paths.push(entry.name);
    if (entry.isDirectory()) {
      paths.push(
        ...(await inventory(join(folder, entry.name))).map((path) => join(entry.name, path)),
      );
    }
  }
  return paths.sort((a, b) => a.localeCompare(b));
}
try {
  for (const name of [
    "drizzle",
    "drizzle.config.ts",
    "src",
    "package.json",
    "tsconfig.json",
    "vite.config.ts",
  ]) {
    await cp(join(app, name), join(consumer, name), { recursive: true });
  }
  await symlink(join(app, "node_modules"), join(consumer, "node_modules"), "dir");
  const prepared = spawnSync(join(app, "node_modules/.bin/tinker"), ["prepare"], {
    cwd: consumer,
    encoding: "utf8",
  });
  assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
  const before = await inventory(join(consumer, "drizzle"));
  const result = spawnSync(join(app, "node_modules/.bin/drizzle-kit"), ["generate"], {
    cwd: consumer,
    encoding: "utf8",
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  assert.equal(result.status, 0, "drizzle-kit generate must accept the copied schema.");
  assert.match(result.stdout + result.stderr, /No schema changes/);
  assert.deepEqual(await inventory(join(consumer, "drizzle")), before);
  console.log(
    "PASS: drizzle-kit generate EXIT 0; No schema changes; no new migration files or folders.",
  );
} finally {
  await rm(consumer, { recursive: true, force: true });
}
