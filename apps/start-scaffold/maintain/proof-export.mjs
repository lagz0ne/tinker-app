import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { releaseUrls } from "../../../packages/start/lib/release.mjs";
import { root } from "./registry-source.mjs";
import { copyTemplates } from "./template-sync.mjs";

/** A real npm install outside the repo; no workspace links or global pnpm/vp. */
const scratch = await mkdtemp(join(tmpdir(), "start-export-proof-"));
const packs = join(scratch, "packs");
const out = join(scratch, "export");
const bin = join(scratch, "bin");
const npm = resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js");

const env = {
  ...process.env,
  PATH: `${bin}:/usr/bin:/bin`,
  VITEST_MAX_WORKERS: "1",
  VP_RUN_CONCURRENCY_LIMIT: "1",
};

function run(command, args, cwd, settings = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 600000, ...settings });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  assert.equal(result.status, 0, `${command}: ${result.error ?? "failed"}`);
}

try {
  await mkdir(bin);
  await symlink(process.execPath, join(bin, "node"));
  await symlink(npm, join(bin, "npm"));
  await symlink(join(dirname(npm), "npx-cli.js"), join(bin, "npx"));
  for (const tool of ["pnpm", "vp"]) {
    assert.equal(
      spawnSync(tool, ["--version"], { env }).error?.code,
      "ENOENT",
      `${tool} must not be global`,
    );
  }

  const released = join(scratch, "released");
  await copyTemplates(released);
  const releasedPkg = JSON.parse(await readFile(join(released, "demo/package.json"), "utf8"));
  assert.equal(
    releasedPkg.devDependencies["@tinker/start"],
    releaseUrls("0.11.0")["@tinker/start"],
  );
  run(process.execPath, [join(root, "packages/start/scripts/pack.mjs"), packs], root);
  await copyTemplates(out, { packs });
  await rm(packs, { recursive: true });

  const app = join(out, "demo");
  const pkg = JSON.parse(await readFile(join(app, "package.json"), "utf8"));
  assert.match(pkg.devDependencies["@tinker/start"], /^file:\.\/vendor\//);
  assert(!/workspace:|catalog:/.test(JSON.stringify(pkg)));
  run("npm", ["install", "--no-audit", "--no-fund"], app, { env });
  run("npm", ["run", "test:proofs"], app, { env });
  run("npm", ["run", "check"], app, { env });
  console.log(
    "PASS standalone export: default export pins the released host; real local install; test:proofs and check pass without repo paths or global pnpm/vp.",
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
