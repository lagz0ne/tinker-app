import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { copyProofApp, proofEnv } from "./proof-app.mjs";

const source = resolve(import.meta.dirname, "..");

const base = dirname(
  createRequire(join(source, "package.json")).resolve("@tinker/start/package.json"),
);

const fixture = await mkdtemp(join(tmpdir(), "start-scaffold-entry-"));

/** Run each proof with local settings and real in-memory Postgres; every child owns its scopes. */
function run(command, args) {
  const child = spawnSync(command, args, {
    cwd: fixture,
    env: { ...process.env, ...proofEnv },
    stdio: "inherit",
    timeout: 180000,
  });
  assert.equal(child.status, 0, `${command} ${args.join(" ")}: ${child.error ?? "failed"}`);
}

try {
  await copyProofApp(source, fixture);
  run(process.execPath, [join(base, "scripts/check-entry-hmr.mjs"), fixture]);
  run(process.execPath, [join(base, "scripts/check-command-build.mjs"), fixture]);

  run("vp", ["build"]);
  run(process.execPath, [join(base, "scripts/check-built-entry.mjs"), fixture]);
  console.log(
    "Scaffold entry: auth and sync on; HMR, tree shaking, build, start and close; EXIT 0",
  );
} finally {
  await rm(fixture, { recursive: true, force: true });
}
