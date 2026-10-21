import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// PR #3, concurrency 1: 13,217.357 s / 1,814 tested mutants = 7.2863 s.
// Count every planned line as one possible mutant; keep baseline time on top.
export const sizing = { secondsPerLine: 7.29, baselineSeconds: 200, targetMinutes: 60 };

/** Stable file-first packing; oversized files become bounded range pieces. */
export function splitPlan(plan) {
  const order = ["changed", "adjacent", "testMapped"];
  const ranges = [...plan.ranges].sort(
    (a, b) =>
      order.indexOf(a.source) - order.indexOf(b.source) ||
      compare(a.file, b.file) ||
      a.start - b.start,
  );
  const files = new Map();
  for (const range of ranges) {
    const file = files.get(range.file) ?? { file: range.file, lines: 0, ranges: [] };
    file.lines += range.end - range.start + 1;
    file.ranges.push(range);
    files.set(range.file, file);
  }
  const capacity = Math.floor(
    (sizing.targetMinutes * 60 - sizing.baselineSeconds) / sizing.secondsPerLine,
  );
  const units = [...files.values()].flatMap((file) => splitFile(file, capacity));
  const count = Math.max(1, Math.min(units.length, Math.ceil(plan.plannedLines / capacity)));
  const shards = Array.from({ length: count }, (_, index) => ({
    id: String(index + 1),
    files: [],
    ranges: [],
    plannedLines: 0,
    counts: { changed: 0, adjacent: 0, testMapped: 0 },
  }));

  units
    .sort(
      (a, b) =>
        b.lines - a.lines || compare(a.file, b.file) || a.ranges[0].start - b.ranges[0].start,
    )
    .forEach((file) => {
      const shard = [...shards].sort(
        (a, b) => a.plannedLines - b.plannedLines || compare(a.id, b.id),
      )[0];
      if (!shard.files.includes(file.file)) shard.files.push(file.file);
      shard.ranges.push(...file.ranges);
      shard.plannedLines += file.lines;
      file.ranges.forEach((range) => {
        shard.counts[range.source] += range.end - range.start + 1;
      });
    });

  return shards.map((shard) => ({
    ...shard,
    files: shard.files.sort(compare),
    // Retain changed-first ordering so multiline mutants keep the same owner.
    ranges: shard.ranges.sort(
      (a, b) =>
        order.indexOf(a.source) - order.indexOf(b.source) ||
        compare(a.file, b.file) ||
        a.start - b.start,
    ),
    estimatedMinutes: (shard.plannedLines * sizing.secondsPerLine + sizing.baselineSeconds) / 60,
  }));
}

function splitFile(file, capacity) {
  const pieces = [];
  let piece = { file: file.file, lines: 0, ranges: [] };
  for (const range of file.ranges) {
    let start = range.start;
    while (start <= range.end) {
      const end = Math.min(range.end, start + capacity - piece.lines - 1);
      piece.ranges.push({ ...range, start, end });
      piece.lines += end - start + 1;
      start = end + 1;
      if (piece.lines === capacity) {
        pieces.push(piece);
        piece = { file: file.file, lines: 0, ranges: [] };
      }
    }
  }
  if (piece.lines) pieces.push(piece);
  return pieces;
}

function compare(a, b) {
  return a < b ? -1 : Number(a > b);
}

/** Summing counts preserves the score; averaging shard percentages does not. */
export function mutationCounts(report) {
  const counts = {
    Killed: 0,
    Timeout: 0,
    Survived: 0,
    NoCoverage: 0,
    Ignored: 0,
    RuntimeError: 0,
    CompileError: 0,
  };
  for (const { mutants } of Object.values(report.files)) {
    mutants.forEach(({ status }) => {
      if (!Object.hasOwn(counts, status)) {
        throw new Error(`Unfinished or unknown mutant status: ${status}`);
      }
      counts[status]++;
    });
  }
  return counts;
}

export function score(counts) {
  const detected = counts.Killed + counts.Timeout;
  const total = detected + counts.Survived + counts.NoCoverage;
  return total ? (100 * detected) / total : 100;
}

/** Missing, duplicated, failed or foreign shards cannot produce a green gate. */
export function combine(manifest, results) {
  const expected = manifest.apps.flatMap((app) =>
    app.shards.map((shard) => ({ app, shard, key: `${app.app}/${shard.id}` })),
  );
  const keys = results.map(({ run }) => `${run.app}/${run.shardId}`);
  if (new Set(keys).size !== keys.length || keys.length !== expected.length) {
    throw new Error("Missing or duplicate shard results");
  }

  return manifest.apps.map((app) => {
    const counts = mutationCounts({ files: {} });
    expected
      .filter((item) => item.app === app)
      .forEach(({ shard, key }) => {
        const result = results.find(({ run }) => `${run.app}/${run.shardId}` === key);
        if (!result) throw new Error(`Missing shard ${key}`);
        checkResult(app, shard, result);
        const subtotal = mutationCounts(result.report);
        Object.keys(counts).forEach((status) => {
          counts[status] += subtotal[status];
        });
      });
    return { app: app.app, shards: app.shards.length, counts, score: score(counts) };
  });
}

function checkResult(app, shard, { run, report, cap }) {
  if (run.exitCode !== 0 || !run.capValid || run.base !== app.base || run.head !== app.head) {
    throw new Error(`Failed or foreign shard ${app.app}/${shard.id}`);
  }
  const mutate = shard.ranges.map(({ file, start, end }) => `${file}:${start}-${end}`);
  if (JSON.stringify(run.mutate) !== JSON.stringify(mutate)) {
    throw new Error(`Wrong planned ranges for ${app.app}/${shard.id}`);
  }
  if (!capMatches(report, cap)) throw new Error(`Invalid line cap for ${app.app}/${shard.id}`);
  cap.forEach(({ line }) => {
    const separator = line.lastIndexOf(":");
    const file = line.slice(0, separator);
    const number = Number(line.slice(separator + 1));
    if (
      !shard.ranges.some(
        (range) => range.file === file && range.start <= number && range.end >= number,
      )
    ) {
      throw new Error(`Mutant outside shard: ${line}`);
    }
  });
}

/** Both runner and combiner require the report to match the exact capped selection. */
export function capMatches(report, cap) {
  const expected = cap.map(({ line, id }) => `${line.replace(/:\d+$/, "")}:${id}`);
  const actual = Object.entries(report.files).flatMap(([file, { mutants }]) =>
    mutants.filter((mutant) => mutant.status !== "Ignored").map(({ id }) => `${file}:${id}`),
  );
  return (
    new Set(cap.map(({ line }) => line)).size === cap.length &&
    new Set(expected).size === expected.length &&
    new Set(actual).size === actual.length &&
    actual.length === expected.length &&
    actual.every((id) => expected.includes(id))
  );
}

/** The workflow uses the same split as the runner; no fixed-size matrix to truncate it. */
export function manifestFor(plans) {
  const apps = [...plans]
    .sort((a, b) => compare(a.app, b.app))
    .map((plan) => ({
      app: plan.app,
      base: plan.base,
      head: plan.head,
      plannedLines: plan.plannedLines,
      shards: splitPlan(plan),
    }));
  const include = apps.flatMap((app) =>
    app.shards.map((shard) => ({ app: app.app.split("/").at(-1), shard: shard.id })),
  );
  if (include.length > 256) {
    throw new Error("Plan exceeds GitHub's 256-job matrix limit; no lines were dropped");
  }
  return { version: 1, sizing, apps, matrix: { include } };
}

function findFiles(folder, name) {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(folder, entry.name);
    return entry.isDirectory() ? findFiles(path, name) : entry.name === name ? [path] : [];
  });
}

function summary(text) {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
}

function matrixCommand(folder, destination) {
  const plans = findFiles(folder, "diff-plan.json").map((file) =>
    JSON.parse(readFileSync(file, "utf8")),
  );
  if (
    plans.length !== 2 ||
    JSON.stringify(plans.map((plan) => plan.app).sort(compare)) !==
      JSON.stringify(["apps/issue-board", "apps/start-scaffold"])
  ) {
    throw new Error("Both app plans are required");
  }
  const manifest = manifestFor(plans);

  writeFileSync(destination, JSON.stringify(manifest, null, 2) + "\n");
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(manifest.matrix)}\n`);
  }

  const rows = manifest.apps.flatMap((app) =>
    app.shards.map(
      (shard) =>
        `| ${app.app} | ${shard.id} | ${shard.plannedLines} | ${shard.estimatedMinutes.toFixed(1)} |`,
    ),
  );
  summary(
    `## Mutation shards\n\nFile split, with oversized files split by range; estimates include a 200 s baseline. Target: about 60 minutes, not a hard time guarantee. No changed lines omitted.\n\n| App | Shard | Lines | Estimated minutes |\n| --- | --- | ---: | ---: |\n${rows.join("\n")}\n`,
  );
}

function aggregateCommand(manifestPath, folder) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const results = findFiles(folder, "diff-run.json").map((file) => ({
    run: JSON.parse(readFileSync(file, "utf8")),
    report: JSON.parse(readFileSync(resolve(dirname(file), "diff.json"), "utf8")),
    cap: JSON.parse(readFileSync(resolve(dirname(file), "diff-line-cap.json"), "utf8")),
  }));
  const combined = combine(manifest, results);

  mkdirSync("reports/mutation", { recursive: true });
  writeFileSync("reports/mutation/combined.json", JSON.stringify(combined, null, 2) + "\n");

  const rows = combined.map(
    (app) =>
      `| ${app.app} | ${app.shards} | ${app.counts.Killed} | ${app.counts.Timeout} | ${app.counts.Survived} | ${app.counts.NoCoverage} | ${app.score.toFixed(2)}% |`,
  );
  summary(
    `## Combined mutation gate (floor 60)\n\nScores use summed mutant counts, never mean shard percentages.\n\n| App | Shards | Killed | Timeout | Survived | No coverage | Score |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${rows.join("\n")}\n`,
  );
  if (combined.some((app) => app.score < 60)) {
    throw new Error("Combined app mutation score is below 60");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, first, second] = process.argv.slice(2);
  if (command === "matrix") matrixCommand(first, second);
  else if (command === "aggregate") aggregateCommand(first, second);
  else {
    throw new Error(
      "Usage: shards.mjs matrix PLAN_FOLDER MANIFEST | aggregate MANIFEST RESULT_FOLDER",
    );
  }
}
