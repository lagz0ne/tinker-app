import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "worker-trace-control-"));

try {
  for (const [name, target, from, to, reason] of [
    [
      "missing worker batch",
      "tinker/components/telemetry/delivery.ts",
      '["server", "browser", "ssr", "worker"]',
      '["server", "browser", "ssr"]',
      /worker trace must reach collector/,
    ],
    [
      "wrong side",
      "cmds/worker.ts",
      'telemetrySide("worker")',
      'telemetrySide("server")',
      /worker trace side must be worker/,
    ],
  ]) {
    const source = readFileSync(target, "utf8");
    assert(source.includes(from), name);

    const copy = join(directory, name + ".ts");
    writeFileSync(copy, source.replace(from, to));

    const bad = spawnSync(process.execPath, ["maintain/proof-worker-telemetry.mjs"], {
      encoding: "utf8",
      timeout: 30000,
      env: { ...process.env, BOARD_PROOF_FAULT_FILE: target, BOARD_PROOF_FAULT_COPY: copy },
    });

    assert.equal(bad.error, undefined, bad.stdout + bad.stderr);
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stderr, reason);

    console.log("PASS worker telemetry control: " + name);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
