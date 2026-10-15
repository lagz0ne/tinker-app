import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

/** Copy both source owners: tooling tests read the app's actual committed entries. */
export function breakChecks(owner, changes) {
  const repo = resolve(owner, "../..");
  for (const change of changes) {
    assert.ok(
      readFileSync(join(owner, change.file), "utf8").includes(change.find),
      `stale recipe: ${change.name}`,
    );
  }
  if (process.argv.includes("--list")) {
    for (const change of changes) console.log(`${change.file}: ${change.name}`);
    return;
  }

  const only = (process.env.BREAKS ?? "").split(",").filter(Boolean);
  for (const name of only) {
    assert.ok(
      changes.some((change) => change.name.includes(name)),
      `unknown BREAKS: ${name}`,
    );
  }
  const chosen = changes.filter(
    (change) => !only.length || only.some((name) => change.name.includes(name)),
  );
  for (const change of [undefined, ...chosen]) runBreak(repo, owner, change);
}

/** Each run gets a new copy, its own report, and one worker; the source tree is read only. */
function runBreak(repo, owner, change) {
  const scratch = mkdtempSync(join(tmpdir(), "start-break-"));
  try {
    cpSync(repo, scratch, {
      recursive: true,
      filter: (file) =>
        !["node_modules", ".git", "dist", ".stryker-tmp", "packs"].includes(basename(file)),
    });
    for (const folder of ["", "packages/start", "apps/start-scaffold", "apps/start-min"]) {
      symlinkSync(join(repo, folder, "node_modules"), join(scratch, folder, "node_modules"), "dir");
    }
    const copied = join(scratch, relative(repo, owner));
    if (change) {
      const path = join(copied, change.file);
      writeFileSync(
        path,
        readFileSync(path, "utf8").replace(change.find, () => change.replace),
      );
    }

    const report = join(scratch, "result.json");
    const run = spawnSync("vp", ["test", "--reporter=json", `--outputFile=${report}`], {
      cwd: copied,
      env: { ...process.env, VITEST_MAX_WORKERS: "1", VP_RUN_CONCURRENCY_LIMIT: "1" },
      encoding: "utf8",
    });
    const result = JSON.parse(readFileSync(report, "utf8"));
    const label = change ? change.name : "control";
    assert.ok(
      result.testResults.every((file) => file.assertionResults.length > 0),
      `broken suite: ${label}`,
    );
    if (change) assert.ok(result.numFailedTests > 0, `MISSED: ${change.name}`);
    else assert.equal(run.status, 0, run.stdout + run.stderr);
    console.log(`PASS: ${label}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
