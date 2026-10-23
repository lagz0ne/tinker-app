import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * Build dist-cli once before the tests: the frozen tests start bin/tinker-loop.mjs, which runs
 * the built CLI (S2). The app's own tests run the source through tsx (Duke, 2026-10-22 23:53).
 */
export default function setup() {
  execFileSync("vp", ["build"], { cwd: join(import.meta.dirname, ".."), stdio: "inherit" });
}
