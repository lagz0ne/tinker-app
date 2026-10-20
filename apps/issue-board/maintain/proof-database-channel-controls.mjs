import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const target = "tinker/components/database/database.server.ts";

const source = readFileSync(target, "utf8");

const directory = mkdtempSync(join(tmpdir(), "channel-control-"));

try {
  for (const [name, from, to, reason] of [
    [
      "hard-coded start_sync",
      "listener!.query(`LISTEN ${topic}`)",
      'listener!.query("LISTEN start_sync")',
      /database listener must subscribe to requested channel/,
    ],
    [
      "pool error listener removed",
      'client.on("error", (error) => log.error("database.idleLost", { error: String(error) }));',
      "",
      /Unhandled 'error' event[\s\S]*terminating connection due to administrator command/,
    ],
  ]) {
    assert(source.includes(from), name);

    const copy = join(directory, "database.server.ts");
    writeFileSync(copy, source.replace(from, to));

    const bad = spawnSync(process.execPath, ["maintain/proof-database-channel.mjs"], {
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env, BOARD_PROOF_FAULT_FILE: target, BOARD_PROOF_FAULT_COPY: copy },
    });

    assert.equal(bad.error, undefined, bad.stdout + bad.stderr);
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stderr, reason);

    console.log("PASS database channel control: " + name + " fails its named check.");
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
