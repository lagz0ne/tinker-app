import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { onTestFinished } from "vite-plus/test";

/** A temp folder, removed when the test ends. */
export function tempFolder() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tinker-loop-app-")));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
