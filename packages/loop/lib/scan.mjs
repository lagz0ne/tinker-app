import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
 * The ref the scan starts from, or null when git cannot find one. `--base` stays exact.
 * A loop.json branch that tracks a remote resolves to that remote branch, since a local copy
 * such as `next` is often old. Next comes the branch itself, then `<remote>/<branch>` when the
 * repo has one remote.
 * @param {string} app - From --app; why: the repo to ask.
 * @param {{ base?: string, config: string | null }} refs - From --base and loop.json; why:
 *   the exact ref wins, the configured branch follows its remote.
 */
export function scanBase(app, { base, config }) {
  if (base) return resolves(app, base) ? base : null;
  if (!config) return null;

  const upstream = git(app, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    `${config}@{upstream}`,
  ]);
  if (upstream) return upstream;
  if (resolves(app, config)) return config;
  return remoteBranch(app, config);
}

/**
 * @param {string} app - From scanBase; why: the repo to ask.
 * @param {string} branch - From loop.json; why: the branch to find on the one remote.
 */
function remoteBranch(app, branch) {
  const remotes = (git(app, ["remote"]) ?? "").split("\n").filter(Boolean);
  const ref = remotes.length === 1 ? `${remotes[0]}/${branch}` : null;
  return ref && resolves(app, ref) ? ref : null;
}

/**
 * @param {string} app - From scanBase; why: the repo to ask.
 * @param {string} ref - From --base or loop.json; why: the name to look up.
 */
function resolves(app, ref) {
  return git(app, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) !== null;
}

/**
 * The app folder's untracked files and whether it is dirty, taken before the gates run, so
 * files the gates write are not part of the change. Untracked files are null outside git.
 * @param {string} app - From --app; why: the folder to look at.
 */
export function treeBefore(app) {
  const listed = git(app, ["ls-files", "--others", "--exclude-standard", "-z"], { raw: true });
  const status = git(app, ["status", "--porcelain", "--untracked-files=all", "--", "."]);
  return { untracked: listed?.split("\0").filter(Boolean) ?? null, dirty: Boolean(status) };
}

/**
 * The change as a diff, scoped to the app folder, with app-relative paths. It starts where
 * the branch left `base`, so a base that moved on adds no other commits. It ends at the
 * working tree, as the gates see it; the untracked files from before the gates are all added.
 * Returns null when the folder is not in git or the diff is too large to read.
 * @param {string} app - From --app; why: the folder to diff.
 * @param {string} base - From scanBase; why: where the change starts.
 * @param {string[] | null} untracked - From treeBefore; why: the new files of the change.
 */
export function changeDiff(app, base, untracked) {
  const start = git(app, ["merge-base", base, "HEAD"]);
  if (!start || !untracked) return null;

  const tracked = git(app, [
    "-c",
    "core.quotePath=false",
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "-U0",
    "--relative",
    start,
  ]);
  if (tracked === null) return null;

  return [tracked, ...untracked.map((file) => addedFile(app, file))].join("\n");
}

/**
 * An untracked file as a diff that adds every line. Links, binary, large, gone, and
 * unreadable files add nothing.
 * @param {string} app - From changeDiff; why: the folder the path is relative to.
 * @param {string} file - From git ls-files; why: the file to read.
 */
function addedFile(app, file) {
  let text;
  try {
    const stat = lstatSync(join(app, file));
    if (!stat.isFile() || stat.size > 1024 * 1024) return "";
    text = readFileSync(join(app, file), "utf8");
  } catch {
    return "";
  }

  if (text.includes("\0")) return "";
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return [`diff --git a/${file} b/${file}`, `+++ b/${file}`, `@@ -0,0 +1,${lines.length} @@`]
    .concat(lines.map((line) => `+${line}`))
    .join("\n");
}

/**
 * Git's output, or null when it fails or prints more than 256 MB. Trimmed unless `raw`.
 * @param {string} app - From the scan; why: git runs in the app folder.
 * @param {string[]} args - From the scan; why: the git command.
 * @param {{ raw?: boolean }} [options] - From the scan; why: `-z` lists keep every byte.
 */
function git(app, args, { raw = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: app,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) return null;
  return raw ? result.stdout : result.stdout.trim();
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

/**
 * Git ends a path that has a space with a tab; the tab is not part of the name.
 * @param {string} text - From a `+++` header; why: null for a deleted file.
 */
function newPath(text) {
  return text.startsWith("+++ b/") ? text.slice(6).replace(/\t$/, "") : null;
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
