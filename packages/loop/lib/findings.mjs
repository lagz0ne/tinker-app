import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** Severity order for lists: what blocks done comes first. */
export const severities = ["important", "question", "nit", "old"];

/** Status order for lists: open work comes first. */
export const statuses = ["open", "answered", "fixed"];

/** A lock older than this is stale: no tool holds it for more than one read, merge, and write. */
const staleLockMs = 30_000;

/** How long a tool waits for the lock. Longer than staleLockMs, so a stale lock always breaks. */
const lockWaitMs = 40_000;

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
 * Digit runs are folded so a timing or count in a summary does not make a new id.
 * A gate finding passes no summary: one red gate is one finding, whatever its message.
 * @param {{ source: string, rule: string, file: string, summary?: string }} finding - From a
 *   check, judge, or review; why: these fields name the problem, the line does not.
 */
export function findingId({ source, rule, file, summary = "" }) {
  const key = [source, rule, file, summary.replaceAll(/\d+/g, "#")].join("\n");
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

/**
 * Every finding in the app's file, in file order. A missing file has none. Read it inside
 * updateFindings when you will write it back.
 * @param {string} app - From --app; why: whose findings.
 */
export function readFindings(app) {
  const path = findingsPath(app);
  if (!existsSync(path)) return [];

  return readFileSync(path, "utf8")
    .split("\n")
    .map((line, index) => parseRow(path, index + 1, line.trim()))
    .filter(Boolean);
}

/**
 * @param {string} path - From readFindings; why: names the bad file.
 * @param {number} number - From readFindings; why: names the bad line.
 * @param {string} line - From the file; why: the row to parse.
 */
function parseRow(path, number, line) {
  if (!line) return null;

  let row = null;
  try {
    row = JSON.parse(line);
  } catch {
    // The check below names the line.
  }
  if (typeof row?.id !== "string") {
    throw new Error(`${path}:${number} is not a finding: one JSON object with a string id`);
  }
  return row;
}

/**
 * Replace the app's file in one rename, so a stopped run never leaves half a file.
 * Call it inside updateFindings, so no other tool's rows are lost.
 * @param {string} app - From --app; why: whose findings.
 * @param {object[]} findings - From a merge; why: the whole new list.
 */
export function writeFindings(app, findings) {
  const path = join(loopFolder(app), "findings.jsonl");
  const text = findings.map((finding) => JSON.stringify(finding)).join("\n");
  writeFileSync(`${path}.${process.pid}.tmp`, text ? `${text}\n` : "");
  renameSync(`${path}.${process.pid}.tmp`, path);
}

/**
 * Read, change, and write the findings file under `.loop/findings.lock`.
 * Every tool that writes the file uses this, so two tools never drop each other's rows.
 * @param {string} app - From --app; why: whose findings.
 * @param {(findings: object[]) => object[]} change - From the tool; why: the merge to make
 *   on the file as it is now.
 */
export function updateFindings(app, change) {
  const release = lockFindings(app);
  try {
    const next = change(readFindings(app));
    writeFindings(app, next);
    return next;
  } finally {
    release();
  }
}

/**
 * Take `.loop/findings.lock` and return the function that releases it. The file is made
 * with `wx`, so only one tool gets it. It holds the owner's pid and time. A lock whose pid is
 * gone, or that is older than 30 seconds, is stale and is removed. Throws after 40 seconds.
 * @param {string} app - From --app; why: whose findings.
 */
export function lockFindings(app) {
  const path = join(loopFolder(app), "findings.lock");
  const deadline = Date.now() + lockWaitMs;

  for (;;) {
    if (tryLock(path)) return () => rmSync(path, { force: true });
    if (staleLock(path)) rmSync(path, { force: true });
    else if (Date.now() > deadline) {
      throw new Error(`${path} is held by another tool; delete it if no tool is running`);
    } else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

/** @param {string} path - From lockFindings; why: the lock file to make. */
function tryLock(path) {
  try {
    const file = openSync(path, "wx");
    writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    closeSync(file);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

/** @param {string} path - From lockFindings; why: the lock file to judge. */
function staleLock(path) {
  try {
    if (Date.now() - statSync(path).mtimeMs > staleLockMs) return true;
    const { pid } = JSON.parse(readFileSync(path, "utf8"));
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
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
 * A check finding that is gone becomes fixed at `sha`, answered or not; an answer keeps its
 * reason. Scan rows change only when the scan ran. Judge and review findings stay.
 * @param {object[]} previous - From readFindings; why: the state before this run.
 * @param {object[]} current - From the gates and the scan; why: what this run found.
 * @param {{ round: number, sha: string | null, scanned: boolean, dirty: boolean }} run - From
 *   nextRound and git; why: stamps the round and commit, and says which rows this run checked.
 */
export function mergeCheck(previous, current, run) {
  const found = new Map(current.map((finding) => [finding.id, finding]));
  const merged = previous.map((old) => {
    const now = found.get(old.id);
    found.delete(old.id);
    return now ? seenAgain(old, now, run.round) : gone(old, run);
  });

  const added = [...found.values()].map((finding) => ({
    ...finding,
    round: run.round,
    status: "open",
  }));
  return [...merged, ...added];
}

/**
 * A finding this run found again: the latest fields, open unless answered.
 * @param {object} old - From the file; why: keeps its status and answer.
 * @param {object} now - From this run; why: the latest line, summary, and fix.
 * @param {number} round - From nextRound; why: the round that saw it.
 */
function seenAgain(old, now, round) {
  const { sha: _sha, dirty: _dirty, ...kept } = old;
  const status = old.status === "answered" ? "answered" : "open";
  return { ...kept, ...now, round, status };
}

/**
 * A finding this run did not find. It is fixed only when this run checked it.
 * @param {object} old - From the file; why: the row that is gone.
 * @param {{ round: number, sha: string | null, scanned: boolean, dirty: boolean }} run - From
 *   mergeCheck; why: whether the scan ran, and where the fix is.
 */
function gone(old, run) {
  const checked = old.source === "check" && (old.rule === "G1" || run.scanned);
  if (!checked || old.status === "fixed") return old;

  const fixed = { ...old, round: run.round, status: "fixed", sha: run.sha };
  return run.dirty ? { ...fixed, dirty: true } : fixed;
}
