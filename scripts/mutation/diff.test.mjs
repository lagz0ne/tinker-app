import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { changedRanges, selectTests } from "./diff.mjs";

test("new-side diff ranges include additions, not deleted-only hunks", () => {
  assert.deepEqual(
    changedRanges(
      "+++ b/tinker/example.ts\n@@ -2,3 +2,4 @@\n+x\n@@ -9 +10 @@\n+y\n@@ -15,2 +16,0 @@",
    ),
    [
      { file: "tinker/example.ts", start: 2, end: 5 },
      { file: "tinker/example.ts", start: 10, end: 10 },
    ],
  );
});

test("reverse walk keeps both callers, ends at scope, and handles cycles", () => {
  const t1 = { file: "tests/one.test.ts", name: "one" };

  const t2 = { file: "tests/two.test.ts", name: "two" };

  const nodes = [
    { id: "leaf", file: "a.ts", start: 2, end: 8, tests: [t1], callers: ["left", "right"] },
    { id: "left", tests: [t1], callers: ["root"] },
    { id: "right", tests: [t2], callers: ["root", "leaf"] },
    { id: "root", kind: "createScope", tests: [], callers: [] },
  ];

  const result = selectTests(nodes, [{ file: "a.ts", start: 3, end: 3 }], [t1, t2]);

  assert.deepEqual(result.tests, [t1, t2]);

  assert.deepEqual(result.seams, ["root"]);

  assert.equal(result.fallback, false);
});

test("an unobserved handle or native helper uses every recorded test, not zero tests", () => {
  const test = { file: "tests/native.test.ts", name: "native" };

  const node = { id: "quiet", file: "a.ts", start: 1, end: 3, tests: [], callers: [] };

  for (const file of ["a.ts", "native.ts"]) {
    const result = selectTests([node], [{ file, start: 2, end: 2 }], [test]);

    assert.equal(result.fallback, true);

    assert.deepEqual(result.tests, [test]);
  }
});

test("source selection ignores generated diffs larger than Git's capture buffer", async () => {
  const root = mkdtempSync(join(tmpdir(), "mutation-git-"));
  const app = join(root, "apps/example");
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Duke Dao",
    GIT_COMMITTER_NAME: "Duke Dao",
    GIT_AUTHOR_EMAIL: "15101444+lagz0ne@users.noreply.github.com",
    GIT_COMMITTER_EMAIL: "15101444+lagz0ne@users.noreply.github.com",
  };
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };

  try {
    mkdirSync(join(app, "tinker"), { recursive: true });
    mkdirSync(join(app, "public/r"), { recursive: true });
    mkdirSync(join(root, "scripts/mutation"), { recursive: true });
    copyFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "diff.mjs"),
      join(root, "scripts/mutation/diff.mjs"),
    );

    writeFileSync(join(app, "stryker.config.json"), JSON.stringify({ mutate: ["tinker/**/*.ts"] }));
    writeFileSync(join(app, "tinker/value.ts"), "export const value = 1;\n");
    writeFileSync(
      join(app, "public/r/large.json"),
      JSON.stringify({ content: "a".repeat(600000) }),
    );
    git("init", "--quiet");

    git("add", ".");
    git("commit", "--quiet", "-m", "Initial fixture");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(app, "tinker/value.ts"), "export const value = 2;\n");

    writeFileSync(
      join(app, "public/r/large.json"),
      JSON.stringify({ content: "b".repeat(600000) }),
    );
    git("add", ".");
    git("commit", "--quiet", "-m", "Change source and generated fixture");
    const head = git("rev-parse", "HEAD");

    const broad = spawnSync(
      "git",
      ["diff", "--unified=0", `${base}..${head}`, "--", "apps/example"],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(
      broad.error?.code,
      "ENOBUFS",
      "the broad broken boundary must fail for the real buffer limit",
    );
    const { planDiff } = await import(pathToFileURL(join(root, "scripts/mutation/diff.mjs")).href);
    const plan = planDiff({
      app,
      base,
      head,
      map: { nodes: [], gaps: [], tests: [{ file: "tests/value.test.ts", name: "value" }] },
    });

    assert.deepEqual(plan.mutate, ["tinker/value.ts:1-1"]);
    assert.deepEqual(plan.testFiles, ["tests/value.test.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
