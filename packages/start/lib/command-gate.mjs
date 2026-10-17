import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { named } from "./checks/named.mjs";
import { commandFiles } from "./named.mjs";

/** Serial native gate: compile every configured process main, then exercise its host contract. */
export function checkCommands(root, execute = spawnSync) {
  const checked = named(root);
  assert.equal(checked.status, "ok", checked.lines.join("\n"));
  for (const entry of commandFiles(root)) {
    const args = ["build", ...(entry.config ? ["--config", entry.config] : [])];
    const build = execute("vp", args, { cwd: root, stdio: "inherit", timeout: 180000 });
    assert.equal(build.status, 0, `${entry.file}: build failed`);
    assert(
      existsSync(join(root, entry.output)),
      `${entry.file}: build did not emit ${entry.output}`,
    );

    const run = execute(
      process.execPath,
      [fileURLToPath(new URL("./command-check.mjs", import.meta.url)), entry.output, entry.role],
      { cwd: root, stdio: "inherit", timeout: 20000 },
    );
    assert.equal(run.status, 0, `${entry.file}: host check failed`);
    console.log(`PASS process command: ${entry.file}; ${entry.output}`);
  }
}

if (import.meta.main) checkCommands(resolve(process.argv[2] ?? "."));
