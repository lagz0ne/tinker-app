import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, matchesGlob, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { capMatches, mutationCounts, score, splitPlan } from "./shards.mjs";
import { importGraph } from "./span-map.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Git new-side ranges; deletions include both surviving neighbors. */
export function changedRanges(diff) {
  let file;

  const ranges = [];

  diff.split("\n").forEach((line) => {
    if (line.startsWith("+++ ")) file = line.startsWith("+++ b/") ? line.slice(6) : undefined;

    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);

    if (file && hunk) {
      ranges.push({
        file,
        source: hunk[2] === "0" ? "adjacent" : "changed",
        start: Math.max(1, Number(hunk[1]) - Number(hunk[2] === "0")),
        end:
          hunk[2] === "0"
            ? Math.max(1, Number(hunk[1]) + 2)
            : Number(hunk[1]) + Number(hunk[2] ?? 1) - 1,
      });
    }
  });

  return ranges;
}

/** Walk reverse declared deps to each scope/cmd; retain all observed callers, not one lucky path. */
export function selectTests(nodes, changed, inventory) {
  const byId = new Map(nodes.map((node) => [node.id, node]));

  const touched = nodes.filter((node) =>
    changed.some(
      (range) => range.file === node.file && range.start <= node.end && range.end >= node.start,
    ),
  );

  const starts = touched.length
    ? touched
    : nodes.filter((node) => changed.some((range) => range.file === node.file));

  const visited = new Set(starts.map((node) => node.id));

  // Set iteration visits newly added callers once, including cyclic graphs.
  for (const id of visited) {
    byId
      .get(id)
      .callers.filter((caller) => byId.has(caller))
      .forEach((caller) => visited.add(caller));
  }

  const walked = [...visited].map((id) => byId.get(id));

  const tests = new Map(
    walked.flatMap((node) => node.tests ?? []).map((test) => [JSON.stringify(test), test]),
  );

  const seams = walked
    .filter((node) => ["main", "createScope"].includes(node.kind))
    .map((node) => node.id);

  // Native helpers and preset-only handles have no Core span. Fail-safe: use
  // the full recorded inventory instead of dropping changed lines.
  const fallback = !touched.length || touched.some((node) => !node.tests?.length);

  if (fallback || !tests.size) inventory.forEach((test) => tests.set(JSON.stringify(test), test));

  return {
    tests: [...tests.values()],
    nodes: [...visited],
    seams,
    fallback: fallback || !touched.length,
  };
}

/** Keep all changed/adjacent lines; budget only extra test-mapped lines after overlaps. */
export function planRanges(sources, testMappedLineBudget = 200) {
  if (!Number.isInteger(testMappedLineBudget) || testMappedLineBudget < 0) {
    throw new Error("Test-mapped line budget must be a non-negative integer");
  }
  const order = ["changed", "adjacent", "testMapped"];
  const lines = new Map();

  order.forEach((source) => {
    for (const { file, start, end } of sources[source]) {
      for (let line = start; line <= end; line++) {
        const key = `${file}:${line}`;
        if (!lines.has(key)) lines.set(key, { file, line, source });
      }
    }
  });

  const sorted = [...lines.values()].sort(
    (a, b) =>
      order.indexOf(a.source) - order.indexOf(b.source) ||
      (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1),
  );
  const firstMapped = sorted.findIndex(({ source }) => source === "testMapped");
  const selected = sorted.filter(
    ({ source }, index) => source !== "testMapped" || index - firstMapped < testMappedLineBudget,
  );
  const omitted = firstMapped < 0 ? [] : sorted.slice(firstMapped + testMappedLineBudget);
  const counts = { changed: 0, adjacent: 0, testMapped: 0 };
  selected.forEach(({ source }) => counts[source]++);

  return {
    ranges: mergeLines(selected),
    counts,
    plannedLines: selected.length,
    testMappedLineBudget,
    omittedRanges: mergeLines(omitted).map((range) => ({
      ...range,
      reason: `test-mapped line budget ${testMappedLineBudget}; changed and adjacent lines kept first`,
    })),
  };
}

/** Compact both selected and omitted lines without hiding a gap. */
function mergeLines(lines) {
  const ranges = [];
  for (const { file, line, source } of lines) {
    const previous = ranges.at(-1);
    if (previous?.file === file && previous.source === source && previous.end + 1 === line) {
      previous.end = line;
    } else ranges.push({ file, start: line, end: line, source });
  }
  return ranges;
}

/** Intersect a test's direct app imports with the spans that test actually observed. */
export function testImportSpans(app, entries, map) {
  const config = JSON.parse(readFileSync(resolve(app, "stryker.config.json"), "utf8"));
  const imports = importGraph(app, entries);
  const ranges = [];
  const omittedRanges = [];
  const testSources = {};

  entries.forEach((entry) => {
    const files = (imports[entry.file] ?? [])
      .filter((file) => inScope(config, file))
      .sort((a, b) => a.localeCompare(b));
    testSources[entry.file] = files;
    const covered = map.nodes.filter(
      (node) => files.includes(node.file) && node.tests.some((test) => test.file === entry.file),
    );
    ranges.push(...covered.map(({ file, start, end }) => ({ file, start, end })));
    if (!covered.length) {
      omittedRanges.push({
        file: entry.file,
        start: 1,
        end: entry.text.split("\n").length,
        source: "testMapped",
        reason: files.length
          ? "direct imports have no spans covered by this test"
          : "test imports no mutable app source directly",
      });
    }
  });

  return { ranges, omittedRanges, testSources };
}

/** Both direct source changes and imported test targets use the same declared scope. */
function inScope(config, file) {
  return (
    config.mutate.some((pattern) => !pattern.startsWith("!") && matchesGlob(file, pattern)) &&
    !config.mutate.some((pattern) => pattern.startsWith("!") && matchesGlob(file, pattern.slice(1)))
  );
}

/** GitHub shows the complete plan, not a hidden sample in an artifact. */
export function planSummary(plan) {
  const omitted = plan.omittedRanges
    .map(({ file, start, end, reason }) => `| ${file}:${start}-${end} | ${reason} |`)
    .join("\n");
  return `## Mutation plan: ${plan.app}\n\nPlanned source lines: **${plan.plannedLines}**. No total line cap. Test-mapped budget: **${plan.testMappedLineBudget}** lines, in file-and-line order after changed and adjacent lines. Counts are exclusive; overlaps belong to changed, then adjacent, then test-mapped.\n\n| Source | Lines |\n| --- | ---: |\n| Changed | ${plan.counts.changed} |\n| Test-mapped | ${plan.counts.testMapped} |\n| Adjacent | ${plan.counts.adjacent} |\n\n### Every omitted range\n\n${omitted ? `| Range | Reason |\n| --- | --- |\n${omitted}` : "None."}\n\nArid/static filtering and one mutant per planned source line happen after this plan.\n`;
}

export function planDiff({ app, base, head, map }) {
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `git ${args[0]} failed (${result.signal ?? result.status}): ${result.stderr}`,
      );
    }
    return result.stdout;
  };
  const mergeBase = git("merge-base", base, head).trim();
  const prefix = relative(root, app).replaceAll("\\", "/") + "/";
  const config = JSON.parse(readFileSync(resolve(app, "stryker.config.json"), "utf8"));

  // Select names first: generated registry JSON can exceed Git's capture buffer.
  const changedFiles = git(
    "diff",
    "--no-ext-diff",
    "--no-renames",
    "--name-only",
    "-z",
    `${mergeBase}..${head}`,
    "--",
    prefix,
  )
    .split("\0")
    .filter(Boolean)
    .map((file) => file.slice(prefix.length));
  const paths = changedFiles.filter(
    (file) => inScope(config, file) && existsSync(resolve(app, file)),
  );
  const deletedSources = changedFiles.filter(
    (file) => inScope(config, file) && !existsSync(resolve(app, file)),
  );
  const changedTests = changedFiles.filter((file) => /^tests\/.*\.(?:[cm]?[jt]sx?)$/.test(file));
  const tests = changedTests.map((file) => ({
    file,
    text: existsSync(resolve(app, file))
      ? readFileSync(resolve(app, file), "utf8")
      : git("show", `${mergeBase}:${prefix}${file}`),
  }));
  const mapped = testImportSpans(app, tests, map);

  const diff = paths.length
    ? git(
        "diff",
        "--no-ext-diff",
        "--no-renames",
        "--unified=0",
        `${mergeBase}..${head}`,
        "--",
        ...paths.map((file) => prefix + file),
      )
    : "";
  const raw = changedRanges(diff).map((range) => ({
    ...range,
    file: range.file.slice(prefix.length),
  }));
  const sources = {
    changed: raw.filter((range) => range.source === "changed"),
    adjacent: raw.filter((range) => range.source === "adjacent"),
    testMapped: mapped.ranges,
  };
  for (const ranges of Object.values(sources)) {
    for (const range of ranges) {
      const lines = readFileSync(resolve(app, range.file), "utf8").trimEnd().split("\n").length;
      range.start = Math.min(range.start, lines);
      range.end = Math.min(range.end, lines);
    }
  }
  const planned = planRanges(sources);
  const omittedRanges = [
    ...planned.omittedRanges,
    ...mapped.omittedRanges,
    ...deletedSources.map((file) => ({
      file,
      start: 1,
      end: git("show", `${mergeBase}:${prefix}${file}`).split("\n").length,
      source: "adjacent",
      reason: "file deleted; no surviving adjacent lines",
    })),
  ];

  for (const file of new Set(planned.ranges.map((range) => range.file))) {
    if (git("show", `${head}:${prefix}${file}`) !== readFileSync(resolve(app, file), "utf8")) {
      throw new Error(
        `Checked-out ${file} differs from ${head}; measure the requested code, not another revision.`,
      );
    }
  }
  const selection = selectTests(map.nodes, planned.ranges, map.tests);
  const selected = new Map(
    [...selection.tests, ...map.tests.filter((test) => changedTests.includes(test.file))].map(
      (test) => [JSON.stringify(test), test],
    ),
  );
  const files = [...new Set([...selected.values()].map((test) => test.file))].sort((a, b) =>
    a.localeCompare(b),
  );
  if (planned.ranges.length && !files.length) {
    throw new Error("No mapped tests for the diff; collect a complete span map first.");
  }

  return {
    app: prefix.slice(0, -1),
    base: mergeBase,
    requestedBase: base,
    head,
    changedTests,
    deletedSources,
    ...planned,
    sources,
    omittedRanges,
    testSources: mapped.testSources,
    mutate: planned.ranges.map(({ file, start, end }) => `${file}:${start}-${end}`),
    ...selection,
    tests: [...selected.values()],
    testFiles: files,
    gaps: map.gaps,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);

  const value = (flag, fallback) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback);

  const app = resolve(value("--app", "apps/issue-board"));

  const directory = resolve(app, "reports/mutation");

  mkdirSync(directory, { recursive: true });

  const map = JSON.parse(
    readFileSync(resolve(value("--map", resolve(directory, "span-map.json"))), "utf8"),
  );

  const fullPlan = planDiff({
    app,
    base: value("--base", "origin/next"),
    head: value("--head", "HEAD"),
    map,
  });

  const shardId = value("--shard");
  const shard = shardId && splitPlan(fullPlan).find(({ id }) => id === shardId);
  if (shardId && !shard) throw new Error(`Unknown shard ${shardId}`);
  const plan = shard
    ? {
        ...fullPlan,
        ...shard,
        shardId,
        fullPlannedLines: fullPlan.plannedLines,
        mutate: shard.ranges.map(({ file, start, end }) => `${file}:${start}-${end}`),
      }
    : fullPlan;

  writeFileSync(resolve(directory, "diff-plan.json"), JSON.stringify(plan, null, 2) + "\n");

  console.log(
    `Diff: ${plan.mutate.length} changed ranges; ${plan.tests.length} mapped tests in ${plan.testFiles.length} files; ${plan.gaps.length} gaps; conservative fallback=${plan.fallback}`,
  );

  console.log(`Gaps:\n${plan.gaps.join("\n")}`);
  const summary =
    planSummary(plan) +
    (shardId
      ? `\nAssigned shard ${shardId}: ${plan.plannedLines}/${fullPlan.plannedLines} source lines. Other planned files run in their own shards; they are not omitted.\n`
      : "");
  writeFileSync(resolve(directory, "diff-summary.md"), summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);

  if (!args.includes("--plan-only") && plan.mutate.length) {
    const config = JSON.parse(readFileSync(resolve(app, "stryker.config.json"), "utf8"));

    // Stryker's public testFiles option selects files inside its sandbox. A
    // config importing the checkout by absolute path would test unmutated code.
    config.testFiles = plan.testFiles;
    // A weak shard must not fail on its own: the gate sums all shard counts.
    // Startup/test/reporter failures still fail this job and the combined gate.
    if (shardId) config.thresholds = { ...config.thresholds, break: 0 };

    // Only diff runs load this reporter; weekly full runs keep every candidate.
    config.plugins.push("../../scripts/mutation/line-cap.mjs");
    config.reporters.push("diff-line-cap");

    config.jsonReporter = { fileName: "reports/mutation/diff.json" };

    const path = resolve(directory, "diff.stryker.json");

    writeFileSync(path, JSON.stringify(config, null, 2) + "\n");

    const require = createRequire(resolve(app, "package.json"));

    const cli = resolve(
      dirname(require.resolve("@stryker-mutator/core/package.json")),
      "bin/stryker.js",
    );

    for (const name of ["diff-line-cap.json", "diff-line-cap-error.json", "diff.json"]) {
      const previous = resolve(directory, name);

      if (existsSync(previous)) unlinkSync(previous);
    }

    const started = Date.now();

    const result = spawnSync(
      process.execPath,
      [cli, "run", path, "--mutate", plan.mutate.join(",")],
      {
        cwd: app,
        stdio: "inherit",
        env: { ...process.env, VITEST_MAX_WORKERS: "1", VP_RUN_CONCURRENCY_LIMIT: "1" },
      },
    );

    const hasCap =
      existsSync(resolve(directory, "diff-line-cap.json")) &&
      !existsSync(resolve(directory, "diff-line-cap-error.json"));
    const selected = hasCap
      ? JSON.parse(readFileSync(resolve(directory, "diff-line-cap.json"), "utf8"))
      : [];
    const hasReport = existsSync(resolve(directory, "diff.json"));
    const report = hasReport
      ? JSON.parse(readFileSync(resolve(directory, "diff.json"), "utf8"))
      : { files: {} };
    const capValid = hasCap && hasReport && capMatches(report, selected);
    const counts = mutationCounts(report);

    const summary = {
      elapsedMs: Date.now() - started,
      exitCode: capValid ? (result.status ?? 1) : 1,
      childExitCode: result.status,
      capValid,
      base: plan.base,
      head: plan.head,
      app: plan.app,
      shardId,
      mutate: plan.mutate,
      counts,
      score: score(counts),
    };

    writeFileSync(resolve(directory, "diff-run.json"), JSON.stringify(summary, null, 2) + "\n");

    console.log(
      `Mutation result${shardId ? ` (shard ${shardId})` : ""}: ${summary.score.toFixed(2)}%`,
    );
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `\nMutation result${shardId ? ` (shard ${shardId})` : ""}: **${summary.score.toFixed(2)}%**. Shards use the combined app floor of 60.\n`,
      );
    }
    process.exitCode = summary.exitCode;

    if (!capValid) {
      console.error("Diff line cap did not finish; refusing an uncapped result.");
    }
  } else if (!plan.mutate.length) {
    console.log("No app mutation lines changed.");
    writeFileSync(resolve(directory, "diff.json"), JSON.stringify({ files: {} }) + "\n");
    writeFileSync(resolve(directory, "diff-line-cap.json"), "[]\n");
    writeFileSync(
      resolve(directory, "diff-run.json"),
      JSON.stringify(
        {
          app: plan.app,
          shardId,
          base: plan.base,
          head: plan.head,
          mutate: [],
          capValid: true,
          exitCode: 0,
          counts: mutationCounts({ files: {} }),
          score: 100,
        },
        null,
        2,
      ) + "\n",
    );
  }
}
