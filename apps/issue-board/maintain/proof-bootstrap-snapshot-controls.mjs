import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const target = "src/demo/backend/sync.server.ts";
const source = readFileSync(new URL("../" + target, import.meta.url), "utf8");
const before = 'isolationLevel: "repeatable read", ';
assert(source.includes(before));
const directory = mkdtempSync(join(tmpdir(), "board-snapshot-control-"));

try {
  const copy = join(directory, "sync.server.ts");
  writeFileSync(copy, source.replaceAll(before, ""));
  const run = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("proof-bootstrap-snapshot.mjs", import.meta.url))],
    {
      env: { ...process.env, BOARD_PROOF_FAULT_FILE: target, BOARD_PROOF_FAULT_COPY: copy },
      encoding: "utf8",
      timeout: 30000,
    },
  );

  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert(run.stderr.includes("bootstrap data must match its revision snapshot"), run.stderr);
  console.log(
    "PASS broken snapshot control: removing REPEATABLE READ fails the real bootstrap consistency check.",
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
