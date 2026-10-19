import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { mergeCheck, nextRound, readFindings, updateFindings } from "./findings.mjs";
import { readConfig, runGates } from "./gates.mjs";
import { findingList, summary } from "./report.mjs";
import { changeDiff, scanBase, scanDiff, treeBefore } from "./scan.mjs";

/** The exit code for each stop the bin passes on: 128 plus the signal's number. */
const stopCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

const usage =
  "usage: tinker-loop check [--app <dir>] [--base <ref>] | findings [--app <dir>] [--open]";

/**
 * Run one tinker-loop command. Returns the exit code: 0 done, 1 a red gate,
 * 64 bad arguments, 78 a bad loop.json or findings file, 129, 130, or 143 when stopped.
 * @param {{ args: readonly string[], cwd: string, stdout: { write(chunk: string): unknown },
 *   stderr: { write(chunk: string): unknown }, signal?: AbortSignal }} context - From the bin
 *   or a test; why: the command line, the folder it runs from, where to print, and the stop.
 */
export async function main({ args, cwd, stdout, stderr, signal }) {
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
    if (command === "check") return await check(app, { base: options.base, print, signal });
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
 * A run stopped before the write leaves the findings file as it was. Dirty state and untracked
 * files are read before the gates, so files the gates write are not part of the change.
 * @param {string} app - From --app; why: the app to check.
 * @param {{ base?: string, print: (line: string) => void, signal?: AbortSignal }} run - From
 *   main; why: --base overrides loop.json's base, print takes the summary, signal stops gates.
 */
async function check(app, { base, print, signal }) {
  const config = readConfig(app);
  const before = treeBefore(app);
  const gates = await runGates(app, config.gates, { print, signal });
  if (stopCode(signal)) return stopCode(signal);

  const red = gates.filter((gate) => !gate.green);
  const ref = scanBase(app, { base, config: config.base });
  const scan = scanChange(app, { ref, wanted: base, untracked: before.untracked }, print);
  const current = [...red.map((gate) => gate.finding), ...scan.hits];
  const run = { sha: headSha(app), scanned: scan.ran, dirty: before.dirty };
  if (stopCode(signal)) return stopCode(signal);

  let round = 0;
  const merged = updateFindings(app, (previous) => {
    round = nextRound(previous);
    return mergeCheck(previous, current, { ...run, round });
  });

  print(
    `tinker-loop check, round ${round}: ${gates.length - red.length} gates green, ${red.length} red`,
  );
  for (const line of summary(merged)) print(line);
  return red.length > 0 ? 1 : 0;
}

/**
 * Scan the change from `ref`. When it cannot run, it says why, and its rows stay as they are.
 * @param {string} app - From --app; why: the folder to scan.
 * @param {{ ref: string | null, wanted?: string, untracked: string[] | null }} base - From
 *   scanBase, --base, and treeBefore; why: where the change starts, the exact ref asked for
 *   when git could not find it, and the new files from before the gates.
 * @param {(line: string) => void} print - From check; why: the base used, or the skip reason.
 */
function scanChange(app, { ref, wanted, untracked }, print) {
  const diff = ref ? changeDiff(app, ref, untracked) : null;
  if (diff !== null) {
    print(`scan base: ${ref}`);
    return { ran: true, hits: scanDiff(diff) };
  }

  const why = ref ? `git cannot diff from ${ref}` : "no base found; pass --base <ref>";
  print(`scan skipped: ${wanted && !ref ? `git cannot find --base ${wanted}` : why}`);
  print("earlier scan findings stay as they are");
  return { ran: false, hits: [] };
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

/**
 * The exit code of a stopped run, or 0 while it runs.
 * @param {AbortSignal | undefined} signal - From main; why: its reason names the signal.
 */
function stopCode(signal) {
  return signal?.aborted ? (stopCodes[signal.reason] ?? 130) : 0;
}

/** @param {string} app - From check; why: the commit where gone findings were fixed. */
function headSha(app) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: app, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}
