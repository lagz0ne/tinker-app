import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = readFileSync("tinker/components/database/lease.server.ts", "utf8");
const directory = mkdtempSync(join(tmpdir(), "board-checkout-control-"));

const faults = [
  [
    "eager-checkout",
    "let pending: Promise<C> | undefined;",
    "let pending: Promise<C> | undefined = connect();",
    "unused transaction must not check out",
  ],
  [
    "begin-not-awaited",
    "await guard?.begin();",
    "void guard?.begin();",
    "real checkout must await BEGIN",
  ],
  ["ended-check-removed", "guard?.check();", "void 0;", "real checkout must reject ended queries"],
  [
    "healthy-release",
    "connection?.release(broken)",
    "connection?.release(false)",
    "real checkout must forward broken",
  ],
];

try {
  const good = spawnSync(process.execPath, ["maintain/proof-checkout.mjs"], { encoding: "utf8" });
  assert.equal(good.status, 0, good.stdout + good.stderr);
  for (const [name, from, to, reason] of faults) {
    assert(source.includes(from), name);

    const copy = join(directory, name + ".ts");
    writeFileSync(copy, source.replace(from, to));
    const bad = spawnSync(process.execPath, ["maintain/proof-checkout.mjs"], {
      env: { ...process.env, BOARD_PROOF_LEASE_COPY: copy },
      encoding: "utf8",
      timeout: 10000,
    });

    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert((bad.stdout + bad.stderr).includes(reason), bad.stdout + bad.stderr);
    console.log("PASS broken real checkout control: " + name);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
