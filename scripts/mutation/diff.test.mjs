import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, matchesGlob } from "node:path";
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
    git("checkout", "--quiet", "-b", "next", base);
    writeFileSync(join(app, "tinker/upstream.ts"), "export const upstream = true;\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "Advance next independently");
    git("checkout", "--quiet", head);
    const { planDiff } = await import(pathToFileURL(join(root, "scripts/mutation/diff.mjs")).href);
    const plan = planDiff({
      app,
      base: "next",
      head,
      map: { nodes: [], gaps: [], tests: [{ file: "tests/value.test.ts", name: "value" }] },
    });

    assert.equal(plan.base, base, "upstream edits must not become PR edits");
    assert.deepEqual(plan.mutate, ["tinker/value.ts:1-1"]);
    assert.deepEqual(plan.testFiles, ["tests/value.test.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI rejects missing or mismatched cap results, clears stale files, and records exit codes", () => {
  const root = mkdtempSync(join(tmpdir(), "diff-cap-cli-"));
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
    mkdirSync(join(root, "scripts/mutation"), { recursive: true });
    mkdirSync(join(app, "node_modules/@stryker-mutator/core/bin"), { recursive: true });
    copyFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "diff.mjs"),
      join(root, "scripts/mutation/diff.mjs"),
    );
    writeFileSync(join(app, "package.json"), "{}");
    writeFileSync(join(app, "node_modules/@stryker-mutator/core/package.json"), "{}");
    // Fault at the native process boundary: exit zero without running the cap.
    writeFileSync(
      join(app, "node_modules/@stryker-mutator/core/bin/stryker.js"),
      "process.exitCode = 0;\n",
    );
    writeFileSync(
      join(app, "stryker.config.json"),
      JSON.stringify({ mutate: ["tinker/**/*.ts"], plugins: [], reporters: [] }),
    );
    writeFileSync(join(app, "tinker/value.ts"), "export const value = 1;\n");
    git("init", "--quiet");
    git("add", ".");
    git("commit", "--quiet", "-m", "Initial gate fixture");
    const base = git("rev-parse", "HEAD");

    writeFileSync(join(app, "tinker/value.ts"), "export const value = 2;\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "Change gate fixture");
    const directory = join(app, "reports/mutation");

    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "span-map.json"),
      JSON.stringify({
        nodes: [],
        gaps: [],
        tests: [{ file: "tests/value.test.ts", name: "value" }],
      }),
    );
    writeFileSync(join(directory, "diff-line-cap.json"), "[]");
    const run = () =>
      spawnSync(
        process.execPath,
        [join(root, "scripts/mutation/diff.mjs"), "--app", app, "--base", base, "--head", "HEAD"],
        { cwd: root, encoding: "utf8" },
      );

    const result = run();

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /refusing an uncapped result/);
    assert.equal(existsSync(join(directory, "diff-line-cap.json")), false);
    const summary = JSON.parse(readFileSync(join(directory, "diff-run.json")));

    assert.equal(summary.childExitCode, 0);
    assert.equal(summary.exitCode, 1);

    writeFileSync(
      join(app, "node_modules/@stryker-mutator/core/bin/stryker.js"),
      `
      const {writeFileSync} = require("node:fs");
      writeFileSync("reports/mutation/diff-line-cap.json", JSON.stringify([{line:"tinker/value.ts:1",id:"0"}]));
      writeFileSync("reports/mutation/diff.json", JSON.stringify({files:{"tinker/value.ts":{mutants:[{id:"0",status:"Killed"},{id:"1",status:"Ignored"}]}}}));
    `,
    );
    assert.equal(run().status, 0, "a real matching selection/report pair is accepted");

    writeFileSync(
      join(app, "node_modules/@stryker-mutator/core/bin/stryker.js"),
      `
      const {writeFileSync} = require("node:fs");
      writeFileSync("reports/mutation/diff-line-cap.json", JSON.stringify([{line:"tinker/value.ts:1",id:"0"}]));
      writeFileSync("reports/mutation/diff.json", JSON.stringify({files:{"tinker/value.ts":{mutants:[{id:"99",status:"Killed"}]}}}));
    `,
    );
    const mismatched = run();

    assert.equal(mismatched.status, 1);
    assert.match(mismatched.stderr, /refusing an uncapped result/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("both app scopes include write steps, transports, contracts, and tested commands", () => {
  for (const app of ["issue-board", "start-scaffold"]) {
    const config = JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "../../apps", app, "stryker.config.json"),
      ),
    );
    for (const file of [
      "src/backend/issues.server.ts",
      "src/transport/call.server.ts",
      "src/contracts/issue.ts",
      "cmds/server.ts",
      "cmds/worker.ts",
      "cmds/cli.ts",
    ]) {
      assert(
        config.mutate.some((pattern) => !pattern.startsWith("!") && matchesGlob(file, pattern)),
        `${app}: ${file}`,
      );
      assert(
        !config.mutate.some(
          (pattern) => pattern.startsWith("!") && matchesGlob(file, pattern.slice(1)),
        ),
        `${app}: ${file} excluded`,
      );
    }
  }
});
