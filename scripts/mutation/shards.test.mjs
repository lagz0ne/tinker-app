import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { combine, manifestFor, mutationCounts, score, sizing, splitPlan } from "./shards.mjs";

function plan(app = "apps/issue-board") {
  return {
    app,
    base: "base",
    head: "head",
    plannedLines: 1000,
    ranges: [
      { file: "a.ts", start: 1, end: 300, source: "changed" },
      { file: "b.ts", start: 1, end: 300, source: "changed" },
      { file: "c.ts", start: 1, end: 200, source: "adjacent" },
      { file: "d.ts", start: 1, end: 100, source: "testMapped" },
      { file: "a.ts", start: 301, end: 400, source: "testMapped" },
    ],
  };
}

function result(app, shard, statuses = ["Killed"]) {
  const file = shard.files[0];
  const report = {
    files: {
      [file]: { mutants: statuses.map((status, index) => ({ id: String(index), status })) },
    },
  };
  return {
    run: {
      app: app.app,
      base: app.base,
      head: app.head,
      shardId: shard.id,
      exitCode: 0,
      capValid: true,
      mutate: shard.ranges.map(({ file, start, end }) => `${file}:${start}-${end}`),
    },
    cap: statuses.map((_, index) => ({ line: `${file}:${index + 1}`, id: String(index) })),
    report,
  };
}

test("1,000 lines split deterministically into three whole-file shards without omissions", () => {
  const input = plan();
  const shards = splitPlan(input);
  assert.equal(shards.length, 3);
  assert.deepEqual(
    shards.map((shard) => shard.plannedLines),
    [400, 300, 300],
  );
  assert.equal(
    shards.reduce((sum, shard) => sum + shard.plannedLines, 0),
    1000,
  );
  assert(shards.every((shard) => shard.estimatedMinutes <= sizing.targetMinutes));

  const allRanges = shards.flatMap((shard) => shard.ranges);
  assert.deepEqual(allRanges.map(JSON.stringify).sort(), input.ranges.map(JSON.stringify).sort());
  const owners = shards.flatMap((shard) => shard.files);
  assert.equal(new Set(owners).size, owners.length);
  assert(
    shards.some((shard) => shard.ranges.filter((range) => range.file === "a.ts").length === 2),
  );
  assert.deepEqual(splitPlan({ ...input, ranges: [...input.ranges].reverse() }), shards);
});

test("empty plans still get a job; large individual files stay whole and visible", () => {
  const empty = splitPlan({ ...plan(), plannedLines: 0, ranges: [] });
  assert.equal(empty.length, 1);
  assert.deepEqual(empty[0].ranges, []);

  const large = splitPlan({
    ...plan(),
    plannedLines: 1000,
    ranges: [{ file: "large.ts", start: 1, end: 1000, source: "changed" }],
  });
  assert.equal(large.length, 1);
  assert.equal(large[0].plannedLines, 1000);
  assert(large[0].estimatedMinutes > 60);
});

test("combined score sums counts rather than averaging shard scores", () => {
  const manifest = manifestFor([plan()]);
  const app = manifest.apps[0];
  const results = app.shards.map((shard, index) =>
    result(
      app,
      shard,
      index === 0 ? ["Killed", ...Array(9).fill("Survived")] : Array(100).fill("Killed"),
    ),
  );

  const combined = combine(manifest, results)[0];
  assert.equal(combined.score, (100 * 201) / 210);
  assert(combined.score > 60, "one weak shard does not fail an app with combined score above 60");
  assert.equal(combined.counts.Killed, 201);
  assert.equal(combined.counts.Survived, 9);
});

test("score includes timeout and no-coverage and keeps errors separate, like Stryker", () => {
  const counts = mutationCounts({
    files: {
      "a.ts": {
        mutants: [
          "Killed",
          "Timeout",
          "Survived",
          "NoCoverage",
          "Ignored",
          "CompileError",
          "RuntimeError",
        ].map((status) => ({ status })),
      },
    },
  });
  assert.equal(score(counts), 50);
  assert.throws(
    () => mutationCounts({ files: { "a.ts": { mutants: [{ status: "Pending" }] } } }),
    /Unfinished/,
  );
});

test("missing, duplicate, failed, stale and wrongly assigned shards fail closed", () => {
  const manifest = manifestFor([plan()]);
  const app = manifest.apps[0];
  const valid = app.shards.map((shard) => result(app, shard));
  assert.throws(() => combine(manifest, valid.slice(1)), /Missing or duplicate/);
  assert.throws(() => combine(manifest, [valid[0], valid[0], valid[2]]), /Missing or duplicate/);

  for (const patch of [
    { exitCode: 1 },
    { capValid: false },
    { head: "old" },
    { base: "other" },
    { mutate: [] },
    { shardId: "unknown" },
  ]) {
    const broken = structuredClone(valid);
    Object.assign(broken[0].run, patch);
    assert.throws(() => combine(manifest, broken), /Failed or foreign|Wrong planned|Missing shard/);
  }
  for (const mutate of [
    (item) => {
      item.cap[0].line = "foreign.ts:1";
      item.report.files["foreign.ts"] = item.report.files[app.shards[0].files[0]];
      delete item.report.files[app.shards[0].files[0]];
    },
    (item) => {
      item.cap.push(item.cap[0]);
    },
    (item) => {
      item.report.files[app.shards[0].files[0]].mutants[0].id = "other";
    },
    (item) => {
      item.report.files[app.shards[0].files[0]].mutants[0].status = "Pending";
    },
  ]) {
    const broken = structuredClone(valid);
    mutate(broken[0]);
    assert.throws(() => combine(manifest, broken), /outside shard|Invalid line cap|Unfinished/);
  }
});

test("matrix refuses GitHub's job limit rather than dropping ranges", () => {
  const ranges = Array.from({ length: 257 }, (_, i) => ({
    file: `file-${i}.ts`,
    start: 1,
    end: 500,
    source: "changed",
  }));
  assert.throws(() => manifestFor([{ ...plan(), plannedLines: 257 * 500, ranges }]), /256-job/);
});

test("native matrix and gate write summaries and fail a low-scoring app separately", () => {
  const folder = mkdtempSync(join(tmpdir(), "mutation-shards-"));
  const cli = join(import.meta.dirname, "shards.mjs");
  const manifestPath = join(folder, "manifest.json");
  const summary = join(folder, "summary.md");
  const output = join(folder, "output.txt");
  const env = { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary };
  const run = (...args) =>
    spawnSync(process.execPath, [cli, ...args], { cwd: folder, env, encoding: "utf8" });

  try {
    for (const app of ["issue-board", "start-scaffold"]) {
      mkdirSync(join(folder, "plans", app), { recursive: true });
      writeFileSync(
        join(folder, "plans", app, "diff-plan.json"),
        JSON.stringify(plan(`apps/${app}`)),
      );
    }

    const matrix = run("matrix", join(folder, "plans"), manifestPath);
    assert.equal(matrix.status, 0, matrix.stderr);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.matrix.include.length, 6);
    assert(readFileSync(output, "utf8").includes('matrix={"include":'));
    assert(readFileSync(summary, "utf8").includes("Estimated minutes"));

    for (const app of manifest.apps) {
      for (const shard of app.shards) {
        const directory = join(folder, "results", app.app.split("/").at(-1), shard.id);
        mkdirSync(directory, { recursive: true });
        const item = result(
          app,
          shard,
          app.app.endsWith("issue-board") ? ["Killed"] : ["Survived"],
        );
        for (const [file, data] of Object.entries({
          "diff-run.json": item.run,
          "diff.json": item.report,
          "diff-line-cap.json": item.cap,
        })) {
          writeFileSync(join(directory, file), JSON.stringify(data));
        }
      }
    }

    const failed = run("aggregate", manifestPath, join(folder, "results"));
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /below 60/);
    assert(readFileSync(summary, "utf8").includes("0.00%"));
    const combined = JSON.parse(
      readFileSync(join(folder, "reports/mutation/combined.json"), "utf8"),
    );
    assert.equal(combined[0].score, 100);
    assert.equal(combined[1].score, 0);

    for (const app of manifest.apps) {
      for (const shard of app.shards) {
        const item = result(app, shard);
        const directory = join(folder, "results", app.app.split("/").at(-1), shard.id);
        writeFileSync(join(directory, "diff.json"), JSON.stringify(item.report));
      }
    }
    const passed = run("aggregate", manifestPath, join(folder, "results"));
    assert.equal(passed.status, 0, passed.stderr);

    const missing = run("aggregate", manifestPath, join(folder, "absent"));
    assert.equal(missing.status, 1, "missing artifacts must not become an empty green score");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("workflow uses a dynamic shard matrix, an always-run combined gate, and unchanged full reports", () => {
  const workflow = readFileSync(
    join(import.meta.dirname, "../../.github/workflows/mutation.yml"),
    "utf8",
  );
  assert.match(workflow, /matrix: \$\{\{ fromJSON\(needs.matrix.outputs.matrix\) \}\}/);
  assert.match(workflow, /--shard \$\{\{ matrix.shard \}\}/);
  assert.match(workflow, /diff-gate:\n    if: always\(\)/);
  assert.match(workflow, /test "\$DIFF_RESULT" = success/);
  assert.match(workflow, /shards.mjs aggregate/);
  assert(!workflow.includes("max-parallel"));

  assert.match(workflow, /timeout-minutes: 180/);
  assert.match(
    workflow,
    /Full app report at floor 60\n        run: pnpm --dir apps\/\$\{\{ matrix.app \}\} exec stryker run/,
  );
});
