import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { onTestFinished } from "vite-plus/test";

/** A temp folder, removed when the test ends. */
export function tempFolder() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tinker-loop-app-")));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A folder with a small @tinker/start of `version` in its node_modules.
 * @param dir - From a test; why: where node_modules goes.
 * @param text - From a test; why: its docs/rules.md, or null for none.
 */
export function start(dir: string, version: string, text: string | null) {
  const folder = join(dir, "node_modules/@tinker/start");
  mkdirSync(join(folder, "docs"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name: "@tinker/start", version }));
  if (text !== null) writeFileSync(join(folder, "docs/rules.md"), text);
  return folder;
}
