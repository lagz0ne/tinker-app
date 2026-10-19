import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { mergeCheck, nextRound, readFindings, writeFindings } from "./findings.mjs";
import { readConfig, runGates } from "./gates.mjs";
import { findingList, summary } from "./report.mjs";
import { changeDiff, scanBase, scanDiff } from "./scan.mjs";

const usage =
  "usage: tinker-loop check [--app <dir>] [--base <ref>] | findings [--app <dir>] [--open]";

/**
 * Run one tinker-loop command. Returns the exit code: 0 done, 1 a red gate,
 * 64 bad arguments, 78 a bad loop.json or findings file.
 * @param {{ args: readonly string[], cwd: string, stdout: { write(chunk: string): unknown },
 *   stderr: { write(chunk: string): unknown } }} context - From the bin or a test; why: the
 *   command line, the folder it runs from, and where to print.
 */
export async function main({ args, cwd, stdout, stderr }) {
  const [command, ...rest] = args;
  const print = (line) => stdout.write(`${line}\n`);
  let options;
  try {
    options = parseArgs({
      args: rest,
      options: { app: { type: "string" }, base: { type: "string" }, open: { type: "boolean" } },
    }).values;
  } catch (error) {
    stderr.write(`${error.message}\n${usage}\n`);
    return 64;
  }

  const app = resolve(cwd, options.app ?? ".");
  try {
    if (command === "check") return check(app, options.base, print);
    if (command === "findings") return findings(app, options.open, print);
  } catch (error) {
    stderr.write(`tinker-loop: ${error.message}\n`);
    return 78;
  }

  stderr.write(`${usage}\n`);
  return 64;
}

/**
 * Run every gate, scan the change, merge into the findings file, and print the summary.
 * @param {string} app - From --app; why: the app to check.
 * @param {string | undefined} base - From --base; why: overrides loop.json's base.
 * @param {(line: string) => void} print - From main; why: where the summary goes.
 */
function check(app, base, print) {
  const config = readConfig(app);
  const previous = readFindings(app);

  const gates = runGates(app, config.gates, print);
  const red = gates.filter((gate) => !gate.green);
  const ref = scanBase(app, { base, config: config.base });
  const diff = ref ? changeDiff(app, ref) : null;
  if (diff === null) print(`scan skipped: ${ref ? `no git diff from ${ref}` : "no base ref"}`);
  else print(`scan base: ${ref}`);

  const current = [...red.map((gate) => gate.finding), ...scanDiff(diff ?? "")];
  const round = nextRound(previous);
  const merged = mergeCheck(previous, current, { round, sha: headSha(app) });
  writeFindings(app, merged);

  print(
    `tinker-loop check, round ${round}: ${gates.length - red.length} gates green, ${red.length} red`,
  );
  for (const line of summary(merged)) print(line);
  return red.length > 0 ? 1 : 0;
}

/**
 * Print the findings file as a list.
 * @param {string} app - From --app; why: whose findings.
 * @param {boolean | undefined} open - From --open; why: show only open findings.
 * @param {(line: string) => void} print - From main; why: where the list goes.
 */
function findings(app, open, print) {
  const all = readFindings(app);
  for (const line of findingList(open ? all.filter((f) => f.status === "open") : all)) print(line);
  return 0;
}

/** @param {string} app - From check; why: the commit where gone findings were fixed. */
function headSha(app) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: app, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}
