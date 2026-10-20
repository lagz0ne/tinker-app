import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, matchesGlob, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Git new-side ranges; deletions include both surviving neighbors. */
export function changedRanges(diff) {
  let file;

  const ranges = [];

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) file = line.startsWith("+++ b/") ? line.slice(6) : undefined;

    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);

    if (file && hunk) {
      ranges.push({
        file,
        start: Math.max(1, Number(hunk[1])),
        end:
          hunk[2] === "0"
            ? Math.max(1, Number(hunk[1]) + 1)
            : Number(hunk[1]) + Number(hunk[2] ?? 1) - 1,
      });
    }
  }

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

/** Bound diff work to 400 stable source lines; weekly full reports do not use this plan. */
export function budgetRanges(ranges, budget = 400) {
  const lines = new Map();

  for (const { file, start, end } of ranges) {
    for (let line = start; line <= end; line++) {
      const key = `${file}:${line}`;
      lines.set(key, { file, line, key, rank: createHash("sha256").update(key).digest("hex") });
    }
  }

  const ranked = [...lines.values()].sort((a, b) =>
    a.rank < b.rank ? -1 : Number(a.rank > b.rank),
  );
  const selected = ranked
    .slice(0, budget)
    .sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  const sampled = [];

  for (const { file, line } of selected) {
    const previous = sampled.at(-1);
    if (previous?.file === file && previous.end + 1 === line) previous.end = line;
    else sampled.push({ file, start: line, end: line });
  }

  return {
    ranges: sampled,
    plannedLines: lines.size,
    omittedLines: ranked.slice(budget).map(({ key }) => key),
  };
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

  // Select names first: generated registry JSON can exceed spawnSync's buffer.
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

  const canMutate = (file) =>
    config.mutate.some((pattern) => !pattern.startsWith("!") && matchesGlob(file, pattern)) &&
    !config.mutate.some(
      (pattern) => pattern.startsWith("!") && matchesGlob(file, pattern.slice(1)),
    );
  const paths = changedFiles.filter((file) => canMutate(file) && existsSync(resolve(app, file)));
  const deletedSources = changedFiles.filter(
    (file) => canMutate(file) && !existsSync(resolve(app, file)),
  );
  const changedTests = changedFiles.filter((file) => /^tests\/.*\.(?:[cm]?[jt]sx?)$/.test(file));
  const observedTests = new Set(
    map.nodes.flatMap((node) => node.tests ?? []).map((test) => test.file),
  );
  const testFallback = changedTests.some((file) => !observedTests.has(file));
  const testedNodes = map.nodes.filter(
    (node) =>
      canMutate(node.file) &&
      (deletedSources.length > 0 ||
        (changedTests.length > 0 &&
          (testFallback || node.tests?.some((test) => changedTests.includes(test.file))))),
  );

  if (changedTests.length + deletedSources.length > 0 && !testedNodes.length) {
    throw new Error(
      "Changed tests or deleted sources have no surviving source spans; collect a complete span map before mutation.",
    );
  }

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
  const ranges = [
    ...changedRanges(diff).map((range) => ({
      ...range,
      file: range.file.slice(prefix.length),
    })),
    ...testedNodes.map(({ file, start, end }) => ({ file, start, end })),
  ].map((range) => {
    const lines = readFileSync(resolve(app, range.file), "utf8").trimEnd().split("\n").length;
    return { ...range, start: Math.min(range.start, lines), end: Math.min(range.end, lines) };
  });

  for (const file of new Set(ranges.map((range) => range.file))) {
    if (git("show", `${head}:${prefix}${file}`) !== readFileSync(resolve(app, file), "utf8")) {
      throw new Error(
        `Checked-out ${file} differs from ${head}; measure the requested code, not another revision.`,
      );
    }
  }

  const budget = budgetRanges(ranges);

  const selection = selectTests(map.nodes, budget.ranges, map.tests);

  const files = [...new Set(selection.tests.map((test) => test.file))].sort((a, b) =>
    a.localeCompare(b),
  );

  if (ranges.length && !files.length) {
    throw new Error("No mapped tests for the diff; collect a complete span map first.");
  }

  return {
    app: prefix.slice(0, -1),
    base: mergeBase,
    requestedBase: base,
    changedTests,
    deletedSources,
    testFallback,
    head,
    ...budget,
    mutate: budget.ranges.map(({ file, start, end }) => `${file}:${start}-${end}`),
    ...selection,
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

  const plan = planDiff({
    app,
    base: value("--base", "origin/next"),
    head: value("--head", "HEAD"),
    map,
  });

  writeFileSync(resolve(directory, "diff-plan.json"), JSON.stringify(plan, null, 2) + "\n");

  console.log(
    `Diff: ${plan.mutate.length} changed ranges; ${plan.tests.length} mapped tests in ${plan.testFiles.length} files; ${plan.gaps.length} gaps; conservative fallback=${plan.fallback}`,
  );

  console.log(`Gaps:\n${plan.gaps.join("\n")}`);
  console.log(
    `Line budget: ${plan.plannedLines} planned; ${plan.omittedLines.length} omitted; at most 400 selected. Full coverage: workflow_dispatch.`,
  );

  if (!args.includes("--plan-only") && plan.mutate.length) {
    const config = JSON.parse(readFileSync(resolve(app, "stryker.config.json"), "utf8"));

    // Stryker's public testFiles option selects files inside its sandbox. A
    // config importing the checkout by absolute path would test unmutated code.
    config.testFiles = plan.testFiles;

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
    const expected = new Set(selected.map(({ line, id }) => `${line.replace(/:\d+$/, "")}:${id}`));
    const hasReport = existsSync(resolve(directory, "diff.json"));
    const actual = hasReport
      ? Object.entries(
          JSON.parse(readFileSync(resolve(directory, "diff.json"), "utf8")).files,
        ).flatMap(([file, { mutants }]) =>
          mutants
            .filter((mutant) => mutant.status !== "Ignored")
            .map((mutant) => `${file}:${mutant.id}`),
        )
      : [];
    const capValid =
      hasCap &&
      hasReport &&
      expected.size === selected.length &&
      new Set(selected.map(({ line }) => line)).size === selected.length &&
      actual.length === expected.size &&
      new Set(actual).size === actual.length &&
      actual.every((id) => expected.has(id));

    const summary = {
      elapsedMs: Date.now() - started,
      exitCode: capValid ? (result.status ?? 1) : 1,
      childExitCode: result.status,
      capValid,
      base: plan.base,
      head: plan.head,
    };

    writeFileSync(resolve(directory, "diff-run.json"), JSON.stringify(summary, null, 2) + "\n");

    process.exitCode = summary.exitCode;

    if (!capValid) {
      console.error("Diff line cap did not finish; refusing an uncapped result.");
    }
  } else if (!plan.mutate.length) console.log("No app mutation lines changed.");
}
