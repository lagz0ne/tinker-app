import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const app = resolve(import.meta.dirname, "..");
const roots = process.argv.slice(2).filter((arg) => arg !== "--prove");
if (!roots.length) roots.push(app, resolve(app, "../start-min"));

for (const root of roots) {
  for (const file of readdirSync(join(root, "cmds"))) {
    const text = readFileSync(join(root, "cmds", file), "utf8");
    assert.ok(
      !/\bprocess\s*\.|loadEnvFile|\bonce\s*\(/.test(text),
      `${root}/cmds/${file}: host inputs only; no process., loadEnvFile or once()`,
    );
  }
}

console.log("PASS: cmds have no process., loadEnvFile or once().");

if (process.argv.includes("--prove")) {
  const scratch = mkdtempSync(join(tmpdir(), "start-command-inputs-"));
  try {
    mkdirSync(join(scratch, "cmds"));
    for (const code of ["process.env.X", "loadEnvFile()", "once(() => {})"]) {
      writeFileSync(join(scratch, "cmds/server.ts"), code);
      const ran = spawnSync(process.execPath, [import.meta.filename, scratch], {
        encoding: "utf8",
      });
      assert.equal(ran.status, 1, code);
      assert.ok(ran.stderr.includes("host inputs only"));
      console.log(`PASS: command plant ${code} EXIT 1.`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
