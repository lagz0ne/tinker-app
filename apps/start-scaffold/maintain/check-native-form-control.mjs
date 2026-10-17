import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = mkdtempSync(join(tmpdir(), "native-form-control-"));

try {
  const copy = join(directory, "App.tsx");
  writeFileSync(
    copy,
    readFileSync(new URL("../src/frontend/App.tsx", import.meta.url), "utf8").replace(
      'method="post"',
      "",
    ),
  );
  const run = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("check-native-form.mjs", import.meta.url))],
    { env: { ...process.env, BOARD_NATIVE_FORM_SOURCE: copy }, encoding: "utf8", timeout: 60000 },
  );

  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert(run.stderr.includes("native submit must POST without URL credentials"), run.stderr);
  console.log("PASS broken native-submit control: missing method fails on GET credentials.");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
