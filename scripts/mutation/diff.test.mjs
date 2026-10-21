import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  symlinkSync,
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

import { planRanges, planSummary, changedRanges, selectTests } from "./diff.mjs";

test("new-side diff ranges include additions and surviving deletion neighbors", () => {
  assert.deepEqual(
    changedRanges(
      "+++ b/tinker/example.ts\n@@ -2,3 +2,4 @@\n+x\n@@ -9 +10 @@\n+y\n@@ -15,2 +16,0 @@",
    ),
    [
      { file: "tinker/example.ts", start: 2, end: 5, source: "changed" },
      { file: "tinker/example.ts", start: 10, end: 10, source: "changed" },
      { file: "tinker/example.ts", start: 15, end: 18, source: "adjacent" },
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
    for (const file of ["diff.mjs", "span-map.mjs"]) {
      copyFileSync(join(import.meta.dirname, file), join(root, "scripts/mutation", file));
    }

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

    mkdirSync(join(app, "tests"), { recursive: true });
    symlinkSync(join(process.cwd(), "node_modules"), join(app, "node_modules"), "dir");
    writeFileSync(
      join(app, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          moduleResolution: "bundler",
          baseUrl: ".",
          paths: { "@/*": ["./tinker/*"] },
        },
      }),
    );
    writeFileSync(join(app, "tests/middle.ts"), 'export * from "./middle2";\n');
    writeFileSync(
      join(app, "tests/middle2.ts"),
      'export {value} from "@/value"; export * from "./middle";\n',
    );

    writeFileSync(
      join(app, "tests/value.test.ts"),
      'import {value} from "./middle"; assert(value);\n',
    );
    git("add", ".");
    git("commit", "--quiet", "-m", "Add source coverage fixture");
    const testBase = git("rev-parse", "HEAD");
    writeFileSync(
      join(app, "tests/value.test.ts"),
      'import {value} from "./middle"; assert(true);\n',
    );
    git("add", ".");
    git("commit", "--quiet", "-m", "Weaken only a test");
    const covered = {
      id: "value",
      file: "tinker/value.ts",
      start: 1,
      end: 1,
      callers: [],
      tests: [{ file: "tests/value.test.ts", name: "value" }],
    };
    const testPlan = planDiff({
      app,
      base: testBase,
      head: "HEAD",
      map: { nodes: [covered], gaps: [], tests: covered.tests },
    });
    assert.deepEqual(
      testPlan.mutate,
      ["tinker/value.ts:1-1"],
      "test-only edits must mutate their covered source",
    );
    assert.deepEqual(testPlan.changedTests, ["tests/value.test.ts"]);

    writeFileSync(
      join(app, "tinker/value.ts"),
      "const first = 1;\nif (!first) throw new Error();\nexport const value = first;\n",
    );
    git("add", ".");
    git("commit", "--quiet", "-m", "Add deletion fixture");
    const deleteBase = git("rev-parse", "HEAD");
    writeFileSync(join(app, "tinker/value.ts"), "const first = 1;\nexport const value = first;\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "Remove only the guard");
    const deletePlan = planDiff({
      app,
      base: deleteBase,
      head: "HEAD",
      map: { nodes: [], gaps: [], tests: covered.tests },
    });
    assert.deepEqual(
      deletePlan.mutate,
      ["tinker/value.ts:1-2"],
      "delete-only hunk must mutate both surviving neighbors",
    );

    writeFileSync(join(app, "tinker/plain.ts"), "export const plain = 1;\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "Add an untraced native helper");

    const removedTestBase = git("rev-parse", "HEAD");
    rmSync(join(app, "tests/value.test.ts"));
    git("add", ".");
    git("commit", "--quiet", "-m", "Remove a test fixture");
    const removedTest = planDiff({
      app,
      base: removedTestBase,
      head: "HEAD",
      map: {
        nodes: [{ ...covered, tests: [] }],
        gaps: [],
        tests: [{ file: "tests/other.test.ts", name: "other" }],
      },
    });
    assert.deepEqual(removedTest.mutate, ["tinker/value.ts:1-1"]);
    assert.deepEqual(removedTest.testSources["tests/value.test.ts"], ["tinker/value.ts"]);
    assert(
      !removedTest.mutate.some((range) => range.startsWith("tinker/plain.ts")),
      "unimported source stays out",
    );

    writeFileSync(join(app, "tinker/remaining.ts"), "export const remaining = true;\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "Add surviving source fixture");
    const deletedSourceBase = git("rev-parse", "HEAD");
    rmSync(join(app, "tinker/value.ts"));
    git("add", ".");
    git("commit", "--quiet", "-m", "Delete a whole source file");
    const deletedSource = planDiff({
      app,
      base: deletedSourceBase,
      head: "HEAD",
      map: {
        nodes: [{ ...covered, file: "tinker/remaining.ts", tests: [] }],
        gaps: [],
        tests: [{ file: "tests/other.test.ts", name: "other" }],
      },
    });
    assert.deepEqual(deletedSource.deletedSources, ["tinker/value.ts"]);
    assert.deepEqual(deletedSource.mutate, []);
    assert.equal(
      deletedSource.omittedRanges[0].reason,
      "file deleted; no surviving adjacent lines",
    );

    const externalBase = git("rev-parse", "HEAD");
    writeFileSync(
      join(app, "tests/external.test.ts"),
      'import {test} from "vite-plus/test"; import type {plain} from "@/plain"; import {type remaining} from "@/remaining"; test("nothing",()=>{});\n',
    );
    git("add", ".");
    git("commit", "--quiet", "-m", "Add a test without mutable imports");
    const external = planDiff({
      app,
      base: externalBase,
      head: "HEAD",
      map: { nodes: [], gaps: [], tests: [{ file: "tests/external.test.ts", name: "nothing" }] },
    });
    assert.deepEqual(external.mutate, []);
    assert.equal(external.omittedRanges[0].reason, "test imports no mutable app source");
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
    for (const file of ["diff.mjs", "span-map.mjs"]) {
      copyFileSync(join(import.meta.dirname, file), join(root, "scripts/mutation", file));
    }
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
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, GITHUB_STEP_SUMMARY: join(root, "job-summary.md") },
        },
      );

    const result = run();

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /refusing an uncapped result/);
    assert.equal(existsSync(join(directory, "diff-line-cap.json")), false);
    const summary = JSON.parse(readFileSync(join(directory, "diff-run.json")));

    assert(readFileSync(join(root, "job-summary.md"), "utf8").includes("| Changed | 1 |"));
    assert(
      readFileSync(join(directory, "diff-summary.md"), "utf8").includes("Every omitted range"),
    );

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

test("changed lines have no total budget and own every overlap", () => {
  const plan = planRanges({
    changed: [{ file: "a.ts", start: 1, end: 700 }],
    adjacent: [{ file: "a.ts", start: 699, end: 702 }],
    testMapped: [{ file: "a.ts", start: 300, end: 1000 }],
  });
  assert.equal(plan.plannedLines, 1000);
  assert.deepEqual(plan.counts, { changed: 700, adjacent: 2, testMapped: 298 });
  assert.deepEqual(plan.ranges[0], { file: "a.ts", start: 1, end: 700, source: "changed" });
  assert.equal(
    plan.ranges.reduce((count, range) => count + range.end - range.start + 1, 0),
    1000,
  );
});

test("job summary shows plan size, source counts, and every omitted range", () => {
  const plan = {
    app: "apps/example",
    plannedLines: 705,
    counts: { changed: 700, testMapped: 3, adjacent: 2 },
    omittedRanges: [
      { file: "tests/external.ts", start: 1, end: 4, reason: "test imports no mutable app source" },
      { file: "a.ts", start: 1, end: 10, reason: "file deleted; no surviving adjacent lines" },
    ],
  };
  const summary = planSummary(plan);
  for (const part of [
    "**705**",
    "| Changed | 700 |",
    "| Test-mapped | 3 |",
    "| Adjacent | 2 |",
    "tests/external.ts:1-4",
    "a.ts:1-10",
    "No total line cap",
  ]) {
    assert(summary.includes(part), part);
  }
});

test("config-only PRs run unconditional gate contracts and actions are immutable", () => {
  const workflow = readFileSync(
    join(import.meta.dirname, "../../.github/workflows/mutation.yml"),
    "utf8",
  );
  assert.match(
    workflow,
    /name: Check mutation gate contracts, including config-only changes\n        working-directory: apps\/issue-board\n        run: node --test --test-concurrency=1 ..\/..\/scripts\/mutation\/\*\.test\.mjs/,
  );
  for (const match of workflow.matchAll(/uses: actions\/[^@]+@([^\s]+)/g)) {
    assert.match(match[1], /^[a-f0-9]{40}$/);
  }
  assert.match(workflow, /group: mutation-\$\{\{ github.ref \}\}\n  cancel-in-progress: true/);
});
