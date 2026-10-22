import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { onTestFinished } from "vite-plus/test";

import { main } from "./api.mjs";

export const pass = 'node -e "process.exit(0)"';
export const fail = 'node -e "process.exit(1)"';

/**
 * A temp git repo holding `files`, committed once, removed when the test ends.
 * @param {Record<string, string>} files - From a test; why: path to text.
 */
export function repo(files) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tinker-loop-")));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "--quiet", "--initial-branch=main");
  commit(root, files, "base");
  return root;
}

/**
 * A temp folder outside git holding `files`, removed when the test ends.
 * @param {Record<string, string>} files - From a test; why: path to text.
 */
export function tempFolder(files) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tinker-loop-plain-")));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

/**
 * Write `files` and commit them.
 * @param {string} root - From repo; why: the repo to commit in.
 * @param {Record<string, string>} files - From a test; why: path to text.
 * @param {string} message - From a test; why: the commit message.
 */
export function commit(root, files, message) {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }

  git(root, "add", "--all");
  git(root, "commit", "--quiet", "--allow-empty", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

/**
 * @param {string} root - From a test; why: the repo.
 * @param {...string} args - From a test; why: the git command.
 */
export function git(root, ...args) {
  const result = spawnSync(
    "git",
    ["-c", "user.name=loop", "-c", "user.email=loop@test", "-c", "commit.gpgsign=false", ...args],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

/**
 * A loop.json with these gates.
 * @param {Record<string, string>} gates - From a test; why: gate name to command.
 * @param {string} [base] - From a test; why: the ref the scan diffs from.
 */
export function loopJson(gates, base) {
  const list = Object.entries(gates).map(([name, run]) => ({ name, run }));
  return JSON.stringify({ gates: list, ...(base ? { base } : {}) });
}

/**
 * Run tinker-loop through its exported main.
 * @param {string} cwd - From a test; why: the folder the command runs in.
 * @param {...string} args - From a test; why: the command line.
 */
export async function loop(cwd, ...args) {
  const out = [];
  const err = [];
  const code = await main({
    args,
    cwd,
    stdout: { write: (chunk) => out.push(chunk) },
    stderr: { write: (chunk) => err.push(chunk) },
  });
  return { code, stdout: out.join(""), stderr: err.join("") };
}

/** @param {string} app - From a test; why: the app whose findings file to read. */
export function findingsOf(app) {
  return readFileSync(join(app, ".loop", "findings.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

/**
 * Rewrite the findings file, as a writer's answer tool would.
 * @param {string} app - From a test; why: the app whose file to change.
 * @param {object[]} findings - From a test; why: the new list.
 */
export function setFindings(app, findings) {
  const text = findings.map((finding) => JSON.stringify(finding)).join("\n");
  writeFileSync(join(app, ".loop", "findings.jsonl"), `${text}\n`);
}
