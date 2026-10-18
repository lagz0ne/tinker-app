import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = readFileSync("tinker/components/database/database.server.ts", "utf8");

const directory = mkdtempSync(join(tmpdir(), "migration-control-"));

try {
  for (const [name, from, to, reason] of [
    [
      "missing lock",
      "pg_try_advisory_lock(1414090315, 1296648018)",
      "true",
      /migration owner must exclude concurrent migrators/,
    ],
    [
      "ignored stop",
      "scope.run(migrate, { signal: resolve(databaseStop) })",
      "scope.run(migrate)",
      /startup migration must settle on worker stop/,
    ],
  ]) {
    assert(source.includes(from));

    const copy = join(directory, name + ".ts");

    writeFileSync(copy, source.replace(from, to));

    const bad = spawnSync(process.execPath, ["maintain/proof-migration-owner.mjs"], {
      encoding: "utf8",
      timeout: 30000,
      env: {
        ...process.env,
        BOARD_PROOF_FAULT_FILE: "tinker/components/database/database.server.ts",
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
