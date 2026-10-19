import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Severity order for lists: what blocks done comes first. */
export const severities = ["important", "question", "nit", "old"];

/** Status order for lists: open work comes first. */
export const statuses = ["open", "answered", "fixed"];

/**
 * Make the app's `.loop` folder. It ignores itself, so git never commits loop state,
 * even in an app whose .gitignore does not name it.
 * @param {string} app - From --app; why: each app keeps its own loop state.
 */
export function loopFolder(app) {
  const folder = join(app, ".loop");
  mkdirSync(folder, { recursive: true });
  if (!existsSync(join(folder, ".gitignore"))) writeFileSync(join(folder, ".gitignore"), "*\n");
  return folder;
}

/**
 * The findings file of one app.
 * @param {string} app - From --app; why: each app keeps its own loop state.
 */
export function findingsPath(app) {
  return join(app, ".loop", "findings.jsonl");
}

/**
 * A stable id: the same problem gets the same id on every run, wherever its line moves.
 * Digit runs are folded so a timing or count in a gate's error line does not make a new id.
 * @param {{ source: string, rule: string, file: string, summary: string }} finding - From a
 *   check, judge, or review; why: these four fields name the problem, the line does not.
 */
export function findingId({ source, rule, file, summary }) {
  const key = [source, rule, file, summary.replaceAll(/\d+/g, "#")].join("\n");
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

/**
 * Every finding in the app's file, in file order. A missing file has none.
 * @param {string} app - From --app; why: whose findings.
 */
export function readFindings(app) {
  const path = findingsPath(app);
  if (!existsSync(path)) return [];

  return readFileSync(path, "utf8")
    .split("\n")
    .map((line, index) => [line.trim(), index + 1])
    .filter(([line]) => line)
    .map(([line, number]) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`${path}:${number} is not one JSON object`);
      }
    });
}

/**
 * Replace the app's file in one rename, so a stopped run never leaves half a file.
 * @param {string} app - From --app; why: whose findings.
 * @param {object[]} findings - From mergeCheck; why: the whole new list.
 */
export function writeFindings(app, findings) {
  const path = join(loopFolder(app), "findings.jsonl");
  const text = findings.map((finding) => JSON.stringify(finding)).join("\n");
  writeFileSync(`${path}.tmp`, text ? `${text}\n` : "");
  renameSync(`${path}.tmp`, path);
}

/**
 * The next round number: one more than any round in the file, from any source.
 * @param {object[]} findings - From readFindings; why: rounds count up across tools.
 */
export function nextRound(findings) {
  return Math.max(0, ...findings.map((finding) => finding.round ?? 0)) + 1;
}

/**
 * Merge one check run into the file's list.
 * A finding seen again keeps its id and an answer's reason, and a fixed one opens again.
 * An open check finding that is gone becomes fixed at `sha`. Judge and review findings stay.
 * @param {object[]} previous - From readFindings; why: the state before this run.
 * @param {object[]} current - From the gates and the scan; why: what this run found.
 * @param {{ round: number, sha: string | null }} run - From nextRound and git; why: stamps
 *   the round and the commit where a finding went away.
 */
export function mergeCheck(previous, current, run) {
  const found = new Map(current.map((finding) => [finding.id, finding]));
  const merged = previous.map((old) => {
    const now = found.get(old.id);
    found.delete(old.id);
    if (now) return seenAgain(old, now, run.round);
    if (old.source !== "check" || old.status !== "open") return old;

    return { ...old, round: run.round, status: "fixed", sha: run.sha };
  });

  const added = [...found.values()].map((finding) => ({
    ...finding,
    round: run.round,
    status: "open",
  }));
  return [...merged, ...added];
}

/**
 * @param {object} old - From the file; why: keeps its status and answer.
 * @param {object} now - From this run; why: the latest line, summary, and fix.
 * @param {number} round - From nextRound; why: the round that saw it.
 */
function seenAgain(old, now, round) {
  const { sha: _sha, ...kept } = old;
  const status = old.status === "answered" ? "answered" : "open";
  return { ...kept, ...now, round, status };
}
