#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The loop's mutation diff gate (docs/decisions/loop-on-tinker.md, ticket 9): Stryker mutates only
 * the src/ TypeScript lines a change adds or edits, at the floor of stryker.config.json (60). The
 * range is from the merge base of --base and --head to --head, on the new side; a pure deletion
 * has no line to mutate. --plan prints the ranges and runs nothing.
 * Usage: node maintain/mutate-diff.mjs --base <sha> --head <sha> [--dir <app>] [--plan]
 */
const args = process.argv.slice(2);
const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const dir = value("--dir") ?? join(import.meta.dirname, "..");
const base = value("--base");
const head = value("--head");

if (!base || !head) {
  process.stderr.write(
    "usage: node maintain/mutate-diff.mjs --base <sha> --head <sha> [--dir <app>] [--plan]\n",
  );
  process.exit(64);
}

const diff = execFileSync(
  "git",
  ["diff", "-U0", "--no-color", "--no-ext-diff", "--relative", `${base}...${head}`, "--", "src"],
  { cwd: dir, encoding: "utf8" },
);

const ranges = [];
let file = null;

for (const line of diff.split("\n")) {
  if (line.startsWith("+++ ")) {
    const path = line.slice(4);
    file = path.startsWith("b/") && path.endsWith(".ts") ? path.slice(2) : null;
    continue;
  }

  const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!file || !hunk) continue;

  const start = Number(hunk[1]);
  const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
  if (count > 0) ranges.push(`${file}:${start}-${start + count - 1}`);
}

if (ranges.length === 0) {
  process.stdout.write("mutation: no changed src lines\n");
  process.exit(0);
}

if (args.includes("--plan")) {
  process.stdout.write(`${ranges.join("\n")}\n`);
  process.exit(0);
}

const reports = join(dir, "reports/mutation");
mkdirSync(reports, { recursive: true });

const config = JSON.parse(readFileSync(join(dir, "stryker.config.json"), "utf8"));
const planned = join(reports, "diff.config.json");

writeFileSync(
  planned,
  JSON.stringify({
    ...config,
    mutate: ranges,
    jsonReporter: { fileName: "reports/mutation/diff.json" },
  }),
);

writeFileSync(join(reports, "diff-ranges.txt"), `${ranges.join("\n")}\n`);

const ran = spawnSync("pnpm", ["exec", "stryker", "run", planned], { cwd: dir, stdio: "inherit" });
process.exit(ran.status ?? 1);
