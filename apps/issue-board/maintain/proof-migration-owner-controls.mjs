import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "migration-control-"));

try {
  for (const [name, target, from, to, reason] of [
    [
      "missing lock",
      "tinker/components/database/database.server.ts",
      "pg_try_advisory_lock(${migrationLockKey[0]}, ${migrationLockKey[1]})",
      "true",
      /migration owner must exclude concurrent migrators/,
    ],
    [
      "ignored stop",
      "tinker/components/database/database.server.ts",
      "scope.run(migrate, { signal: resolve(databaseStop) })",
      "scope.run(migrate)",
      /startup migration must settle on worker stop/,
    ],
    [
      "worker setup removed",
      "cmds/worker.ts",
      "extensions: [databaseSetup, mailStartup]",
      "extensions: [mailStartup]",
      /worker command must await the held migration owner/,
    ],
    [
      "CLI setup removed",
      "cmds/cli.ts",
      "extensions: [databaseSetup]",
      "extensions: []",
      /cli command must await the held migration owner/,
    ],
    ...["server", "worker", "cli"].map((command) => [
      `${command} start budget removed`,
      `cmds/${command}.ts`,
      "startTimeout: 70_000,",
      "",
      new RegExp(`${command} command must outlast Core's 10 s start limit`),
    ]),
  ]) {
    const source = readFileSync(target, "utf8");
    assert(source.includes(from));

    const copy = join(directory, name + ".ts");

    writeFileSync(copy, source.replace(from, to));

    const bad = spawnSync(process.execPath, ["maintain/proof-migration-owner.mjs"], {
      encoding: "utf8",
      timeout: 120000,
      env: {
        ...process.env,
        BOARD_PROOF_FAULT_FILE: target,
        BOARD_PROOF_FAULT_COPY: copy,
      },
    });

    assert.equal(bad.error, undefined, bad.stdout + bad.stderr);

    assert.equal(bad.status, 1, bad.stdout + bad.stderr);

    assert.match(bad.stderr, reason);

    console.log("PASS migration owner control: " + name + " fails its named assertion.");
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
