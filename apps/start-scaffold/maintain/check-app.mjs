import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

/** Named app checks run one by one; builds and the real-service proof never run inside tests. */
const app = resolve(import.meta.dirname, "..");

for (const task of [
  "check:plain",
  "test:schema",
  "test:imports",
  "test:middleware",
  "test:serve",
  "test:seam:fixture",
  "registry:build",
  "test:registry",
  "test:compose",
]) {
  const child = spawn("vp", ["run", task], { cwd: app, stdio: "inherit" });
  const code = await new Promise((done, failed) => {
    child.once("error", failed);
    child.once("close", done);
  });
  console.log(`${task}: EXIT ${code}`);
  assert.equal(code, 0, task);
}
