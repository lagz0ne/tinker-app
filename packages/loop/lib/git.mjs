import { spawnSync } from "node:child_process";

/**
 * Git's output, or null when it fails or prints more than 256 MB. Trimmed unless `raw`.
 * @param {string} app - From a tool; why: git runs in the app folder.
 * @param {string[]} args - From a tool; why: the git command.
 * @param {{ raw?: boolean }} [options] - From a tool; why: `-z` lists keep every byte.
 */
export function git(app, args, { raw = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: app,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) return null;
  return raw ? result.stdout : result.stdout.trim();
}

/**
 * The full sha of the commit `ref` names, or null when it names no commit.
 * @param {string} app - From a tool; why: the repo to ask.
 * @param {string} ref - From a tool or the command line; why: the name to look up.
 */
export function commitSha(app, ref) {
  return git(app, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
}

/** @param {string} app - From a tool; why: the commit the app's tree is on, or null. */
export function headSha(app) {
  return commitSha(app, "HEAD");
}

/**
 * True when commit `older` is `newer` or in its history.
 * @param {string} app - From a tool; why: the repo to ask.
 * @param {string} older - From a tool; why: the commit that must come first.
 * @param {string} newer - From a tool; why: the commit whose history to search.
 */
export function inHistory(app, older, newer) {
  return git(app, ["merge-base", "--is-ancestor", older, newer]) !== null;
}
