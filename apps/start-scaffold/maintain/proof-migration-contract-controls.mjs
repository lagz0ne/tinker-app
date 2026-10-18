import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "migration-contract-"));

const root = resolve(".");

try {
  for (const name of [
    "src",
    "cmds",
    "tinker",
    "drizzle",
    "package.json",
    "tsconfig.json",
    "drizzle.config.ts",
    ...(await readdir(root)).filter((name) =>
      /^vite(?:\.[^.]+)?\.config\.(ts|mts|js|mjs)$/.test(name),
    ),
  ]) {
    await cp(name, join(directory, name), { recursive: true });
  }

  await mkdir(join(directory, "scripts"));
  await cp("scripts/check-schema.mjs", join(directory, "scripts/check-schema.mjs"));

  await symlink(join(root, "node_modules"), join(directory, "node_modules"), "dir");

  const folders = (await readdir(join(directory, "drizzle"))).sort().reverse();

  let target;

  let source;

  for (const folder of folders) {
    const text = await readFile(join(directory, "drizzle", folder, "migration.sql"), "utf8");

    if (text.includes("CREATE OR REPLACE FUNCTION notify_board_outbox")) {
      target = join(directory, "drizzle", folder, "migration.sql");
      source = text;
      break;
    }
  }
  assert(target, "mail notification migration must exist");

  for (const [name, broken, reason] of [
    [
      "trigger removed",
      source.replace(
        /CREATE TRIGGER board_outbox_insert[\s\S]*?EXECUTE FUNCTION notify_board_outbox\(\);/,
        "",
      ),
      /mail migration must install its enabled notification trigger/,
    ],
    [
      "channel changed",
      source.replaceAll("'board_outbox'", "'wrong_outbox'"),
      /mail notification function must publish board_outbox/,
    ],
    [
      "empty guard removed",
      source.replace(/IF EXISTS\s*\(SELECT 1 FROM added\) THEN/, "").replace("END IF;", ""),
      /mail function must suppress empty statement notifications/,
    ],
  ]) {
    assert.notEqual(broken, source, name);
    await writeFile(target, broken);

    const schema = spawnSync(process.execPath, [join(directory, "scripts/check-schema.mjs")], {
      cwd: directory,
      encoding: "utf8",
      timeout: 30000,
    });

    assert.equal(schema.status, 0, schema.stdout + schema.stderr);

    const bad = spawnSync(process.execPath, ["maintain/proof-migration-contract.mjs"], {
      encoding: "utf8",
      timeout: 30000,
      env: { ...process.env, BOARD_PROOF_MIGRATION_ROOT: directory },
    });

    assert.equal(bad.error, undefined, bad.stdout + bad.stderr);
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stderr, reason);

    console.log(
      "PASS migration contract control: schema-only accepts " +
        name +
        "; real migration gate rejects its named contract.",
    );
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
