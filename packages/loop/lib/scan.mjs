import { spawnSync } from "node:child_process";

import { findingId } from "./findings.mjs";

/**
 * The tinker-review quick-scan greps, one rule each. A hit points at a line to read; it is
 * not a verdict. randomUUID is B3 (the unit's random); setInterval is O1 (an owned timer).
 */
export const scans = [
  {
    rule: "B1",
    pattern: /process\.(env|argv|exit)/,
    topic: "process global",
    fix: "Only cmds/* reads process inputs; bind a typed tag instead.",
  },
  {
    rule: "B3",
    pattern: /Date\.now|Math\.random/,
    topic: "clock or random",
    fix: "Use the unit's clock and random.",
  },
  {
    rule: "B3",
    pattern: /randomUUID/,
    topic: "random id",
    fix: "Use the unit's random.",
  },
  {
    rule: "O1",
    pattern: /setInterval/,
    topic: "timer",
    fix: "Give the timer an owner that releases it with defer.",
  },
  {
    rule: "O1",
    pattern: /\bclass [A-Z]/,
    topic: "class",
    fix: "Declare a tag, data, resource, or operation instead of a class.",
  },
  {
    rule: "H3",
    pattern: /\bfetch\(|node:(net|http)/,
    topic: "raw HTTP or socket",
    fix: "Send outgoing HTTP through httpRequest.controller.",
  },
  {
    rule: "H5",
    pattern: /\.skip\(/,
    topic: "skipped test",
    fix: "Run the test or delete it.",
  },
  {
    rule: "H2",
    pattern: / as unknown as /,
    topic: "double cast",
    fix: "Check the input and use the checked result.",
  },
];

/**
 * The ref the scan starts from. A loop.json branch that tracks a remote resolves to that
 * remote branch, since a local copy such as `next` is often old. `--base` stays exact.
 * @param {string} app - From --app; why: the repo to ask.
 * @param {{ base?: string, config: string | null }} refs - From --base and loop.json; why:
 *   the exact ref wins, the configured branch follows its remote.
 */
export function scanBase(app, { base, config }) {
  if (base || !config) return base ?? null;

  const result = spawnSync(
    "git",
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${config}@{upstream}`],
    { cwd: app, encoding: "utf8" },
  );
  return result.status === 0 ? result.stdout.trim() : config;
}

/**
 * The change's diff, scoped to the app folder, with app-relative paths. Three dots: only
 * this branch's commits since it left `base`, so a moved base adds no stranger's lines.
 * Returns null when the folder is not in git or `base` does not resolve.
 * @param {string} app - From --app; why: the folder to diff.
 * @param {string} base - From --base or loop.json; why: where the change starts.
 */
export function changeDiff(app, base) {
  const result = spawnSync(
    "git",
    [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "-U0",
      "--relative",
      `${base}...HEAD`,
    ],
    { cwd: app, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  return result.status === 0 ? result.stdout : null;
}

/**
 * Quick-scan hits on the added lines of a unified diff, as question findings.
 * @param {string} diff - From changeDiff; why: only added lines are the change.
 */
export function scanDiff(diff) {
  const hits = new Map();
  for (const added of addedLines(diff)) {
    for (const hit of lineHits(added)) hits.set(hit.id, hits.get(hit.id) ?? hit);
  }

  return [...hits.values()];
}

/**
 * Each added line with its file and new line number. A file is undefined while its header is
 * read, so only a header's `+++` line names it; an added `++` line never does.
 * @param {string} diff - From changeDiff; why: the text to walk.
 */
function* addedLines(diff) {
  let file;
  let line = 0;

  for (const text of diff.split("\n")) {
    if (text.startsWith("diff --git ")) file = undefined;
    else if (file === undefined && text.startsWith("+++ ")) file = newPath(text);
    else if (text.startsWith("@@ ")) line = hunkStart(text);
    else if (file && text.startsWith("+")) {
      yield { file, line, text: text.slice(1) };
      line += 1;
    }
  }
}

/** @param {string} text - From an `@@` line; why: the new file's first line in the hunk. */
function hunkStart(text) {
  return Number(/\+(\d+)/.exec(text)?.[1]);
}

/** @param {string} text - From a `+++` header; why: null for a deleted file. */
function newPath(text) {
  return text.startsWith("+++ b/") ? text.slice(6) : null;
}

/**
 * @param {{ file: string, line: number, text: string }} added - From addedLines; why: the
 *   file and line name the finding, the text is what the greps read.
 */
function lineHits({ file, line, text }) {
  const code = text.trim();
  const shown = code.length > 120 ? `${code.slice(0, 117)}...` : code;

  return scans
    .filter((scan) => scan.pattern.test(code))
    .map((scan) => {
      const finding = {
        rule: scan.rule,
        severity: "question",
        file,
        line,
        summary: `${scan.topic}: ${shown}`,
        trigger:
          "Quick-scan grep hit on an added line. Read the code before you call it a problem.",
        fix: scan.fix,
        source: "check",
      };
      return { id: findingId(finding), ...finding };
    });
}
