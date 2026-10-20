import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, matchesGlob, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Git's new-side ranges; removed-only hunks have no remaining line to mutate. */
export function changedRanges(diff) {
  let file;
  const ranges = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) file = line.slice(6);
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (file && hunk && hunk[2] !== "0")
      ranges.push({
        file,
        start: Number(hunk[1]),
        end: Number(hunk[1]) + Number(hunk[2] ?? 1) - 1,
      });
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
  const queue = touched.length
    ? [...touched]
    : nodes.filter((node) => changed.some((range) => range.file === node.file));
  const visited = new Set();
  const tests = new Map();
  const seams = [];
  while (queue.length) {
    const node = queue.shift();
    if (visited.has(node.id)) continue;
    visited.add(node.id);
    for (const test of node.tests ?? []) tests.set(JSON.stringify(test), test);
    if (["main", "createScope"].includes(node.kind)) seams.push(node.id);
    for (const id of node.callers) if (byId.has(id)) queue.push(byId.get(id));
  }
  // Native helpers and preset-only handles have no Core span. Fail-safe: run the
  // map's entire test inventory rather than silently dropping those changed lines.
  const fallback = !touched.length || touched.some((node) => !node.tests?.length);
  if (fallback || !tests.size) for (const test of inventory) tests.set(JSON.stringify(test), test);
  return {
    tests: [...tests.values()],
    nodes: [...visited],
    seams,
    fallback: fallback || !touched.length,
  };
}

export function planDiff({ app, base, head, map }) {
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  };
  const prefix = relative(root, app).replaceAll("\\", "/") + "/";
  const config = JSON.parse(readFileSync(resolve(app, "stryker.config.json"), "utf8"));
  const ranges = changedRanges(
    git("diff", "--no-ext-diff", "--no-renames", "--unified=0", `${base}..${head}`, "--", prefix),
  )
    .map((range) => ({ ...range, file: range.file.slice(prefix.length) }))
    .filter(
      ({ file }) =>
        config.mutate.some((pattern) => !pattern.startsWith("!") && matchesGlob(file, pattern)) &&
        !config.mutate.some(
          (pattern) => pattern.startsWith("!") && matchesGlob(file, pattern.slice(1)),
        ),
    );
  for (const file of new Set(ranges.map((range) => range.file))) {
    if (git("show", `${head}:${prefix}${file}`) !== readFileSync(resolve(app, file), "utf8")) {
      throw new Error(
        `Checked-out ${file} differs from ${head}; measure the requested code, not another revision.`,
      );
    }
  }
  const selection = selectTests(map.nodes, ranges, map.tests);
  const files = [...new Set(selection.tests.map((test) => test.file))].sort();
  if (ranges.length && !files.length)
    throw new Error("No mapped tests for the diff; collect a complete span map first.");
  return {
    app: prefix.slice(0, -1),
    base,
    head,
    ranges,
    mutate: ranges.map(({ file, start, end }) => `${file}:${start}-${end}`),
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
  if (!args.includes("--plan-only") && plan.mutate.length) {
    const config = JSON.parse(readFileSync(resolve(app, "stryker.config.json"), "utf8"));
    // Stryker's public testFiles option selects files inside its sandbox. A
    // config importing the checkout by absolute path would test unmutated code.
    config.testFiles = plan.testFiles;
    config.jsonReporter = { fileName: "reports/mutation/diff.json" };
    const path = resolve(directory, "diff.stryker.json");
    writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
    const require = createRequire(resolve(app, "package.json"));
    const cli = resolve(
      dirname(require.resolve("@stryker-mutator/core/package.json")),
      "bin/stryker.js",
    );
    const started = Date.now();
    const result = spawnSync(
      process.execPath,
      [cli, "run", path, "--mutate", plan.mutate.join(","), "--concurrency", "4"],
      {
        cwd: app,
        stdio: "inherit",
        env: { ...process.env, VITEST_MAX_WORKERS: "1", VP_RUN_CONCURRENCY_LIMIT: "1" },
      },
    );
    const summary = {
      elapsedMs: Date.now() - started,
      exitCode: result.status,
      base: plan.base,
      head: plan.head,
    };
    writeFileSync(resolve(directory, "diff-run.json"), JSON.stringify(summary, null, 2) + "\n");
    process.exitCode = result.status ?? 1;
  } else if (!plan.mutate.length) console.log("No app mutation lines changed.");
}
