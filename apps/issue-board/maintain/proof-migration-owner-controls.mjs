import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = readFileSync("tinker/components/database/database.server.ts", "utf8");

const directory = mkdtempSync(join(tmpdir(), "migration-control-"));

try {
  const from = "pg_try_advisory_lock(1414090315, 1296648018)";

  assert(source.includes(from));

  const copy = join(directory, "database.server.ts");

  writeFileSync(copy, source.replace(from, "true"));

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

  assert.match(bad.stderr, /migration owner must exclude concurrent migrators/);

  console.log("PASS migration owner control: missing lock fails the overlap assertion.");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
