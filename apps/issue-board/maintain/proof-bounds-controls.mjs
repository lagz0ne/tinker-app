import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "board-bounds-controls-"));
const sql = "tinker/components/database/database.server.ts";
const mail = "src/backend/alert-mail.server.ts";

try {
  for (const trial of [
    {
      name: "blocked SQL unbounded",
      target: sql,
      script: "proof-sql-cancel.mjs",
      reason: "cancelled blocked SQL must finish rollback before deadline",
      replacements: [
        ["'${lockTimeout}ms'", "'0'"],
        ["'${statementTimeout}ms'", "'0'"],
      ],
    },
    {
      name: "SMTP has no total deadline",
      target: mail,
      script: "proof-alert-grace.mjs",
      reason: "alert send plus record and held COMMIT must end before host hard stop",
      replacements: [["clock.sleep(timeout, timer.signal)", "new Promise(() => {})"]],
    },
    {
      name: "COMMIT unbounded",
      target: sql,
      script: "proof-alert-grace.mjs",
      reason: "alert send plus record and held COMMIT must end before host hard stop",
      replacements: [
        ["'${lockTimeout}ms'", "'0'"],
        ["'${statementTimeout}ms'", "'0'"],
      ],
    },
  ]) {
    let source = readFileSync(trial.target, "utf8");
    for (const [from, to] of trial.replacements) {
      assert(source.includes(from));
      source = source.replace(from, to);
    }

    const copy = join(directory, trial.name + ".ts");
    writeFileSync(copy, source);
    const run = spawnSync(process.execPath, ["maintain/" + trial.script], {
      encoding: "utf8",
      timeout: 30000,
      env: { ...process.env, BOARD_PROOF_FAULT_FILE: trial.target, BOARD_PROOF_FAULT_COPY: copy },
    });

    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert(run.stderr.includes(trial.reason), run.stdout + run.stderr);
    console.log("PASS broken bounds control: " + trial.name);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
