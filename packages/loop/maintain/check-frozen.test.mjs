import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, onTestFinished, test } from "vite-plus/test";

const tests = join(import.meta.dirname, "../tests");
const check = join(import.meta.dirname, "check-frozen.mjs");

/** A copy of the frozen tests folder, removed when the test ends. */
function copy() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tinker-loop-frozen-")));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(tests, dir, { recursive: true });
  return dir;
}

/** @param {string} dir - From a test; why: the tests folder to check. */
function run(dir) {
  return spawnSync(process.execPath, [check, dir], { encoding: "utf8" });
}

test("the frozen tests match frozen.json: 7 files, 120 tests", () => {
  const checked = run(tests);

  expect(checked.stderr).toBe("");
  expect(checked.status).toBe(0);
  expect(checked.stdout).toBe("frozen: 7 test files, 120 tests, unchanged\n");
});

test("a changed, added, or removed test file fails and names the file", () => {
  const changed = copy();
  appendFileSync(join(changed, "check.test.mjs"), "\n");
  const added = copy();
  writeFileSync(join(added, "extra.test.mjs"), "");
  const removed = copy();
  rmSync(join(removed, "rules.test.mjs"));

  const runs = [changed, added, removed].map(run);

  expect(runs.map(({ status }) => status)).toEqual([1, 1, 1]);
  expect(runs[0].stderr).toBe(
    "frozen: check.test.mjs changed; a frozen test does not change after ticket 5\n",
  );
  expect(runs[1].stderr).toBe(
    "frozen: extra.test.mjs is not in frozen.json; a frozen test does not change after ticket 5\n",
  );
  expect(runs[2].stderr).toBe(
    "frozen: rules.test.mjs is gone; a frozen test does not change after ticket 5\n",
  );
});

test("a helper file may change: only *.test.mjs files are frozen", () => {
  const dir = copy();
  appendFileSync(join(dir, "fixture.mjs"), "\n");

  expect(run(dir).status).toBe(0);
});
