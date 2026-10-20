import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = readFileSync("tinker/components/mail/delivery.server.ts", "utf8");

const directory = mkdtempSync(join(tmpdir(), "lease-control-"));

try {
  for (const [name, from, to, reason] of [
    [
      "batch-size",
      ".orderBy(asc(mailOutbox.nextAt), asc(mailOutbox.id))\n      .limit(20)",
      ".orderBy(asc(mailOutbox.nextAt), asc(mailOutbox.id))\n      .limit(19)",
      /mail claim must return disjoint batches of 20 and 1/,
    ],
    [
      "claim-not-committed",
      "claim.run({ signal: contextSignal })",
      "claim.run()",
      /mail send must not hold claim row locks/,
    ],
    [
      "stale-ack",
      "eq(mailOutbox.leaseToken, input.token)",
      "sql`true`",
      /old lease token must not acknowledge a new owner/,
    ],
    [
      "exhausted-row-lock",
      '.for("update", { skipLocked: true })',
      '.for("update")',
      /claim must skip locked exhausted rows/,
    ],
  ]) {
    assert(source.includes(from), name);

    const copy = join(directory, name + ".ts");

    writeFileSync(copy, source.replace(from, to));

    const bad = spawnSync(process.execPath, ["maintain/proof-mail-leases.mjs"], {
      encoding: "utf8",
      timeout: 30000,
      env: {
        ...process.env,
        BOARD_PROOF_FAULT_FILE: "tinker/components/mail/delivery.server.ts",
        BOARD_PROOF_FAULT_COPY: copy,
      },
    });

    assert.equal(bad.error, undefined, bad.stdout + bad.stderr);

    assert.equal(bad.status, 1, bad.stdout + bad.stderr);

    assert.match(bad.stderr, reason);

    console.log("PASS mail leases control: " + name);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
