import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { mergeCheck, nextRound, readFindings, updateFindings } from "./findings.mjs";
import { readConfig, runGates } from "./gates.mjs";
import { findingList, summary } from "./report.mjs";
import { changeDiff, scanBase, scanDiff, treeDirty } from "./scan.mjs";

const usage =
  "usage: tinker-loop check [--app <dir>] [--base <ref>] | findings [--app <dir>] [--open]";

/**
 * Run one tinker-loop command. Returns the exit code: 0 done, 1 a red gate,
 * 64 bad arguments, 78 a bad loop.json or findings file, 130 or 143 when stopped.
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
 * A stopped run writes nothing.
 * @param {string} app - From --app; why: the app to check.
 * @param {{ base?: string, print: (line: string) => void, signal?: AbortSignal }} run - From
 *   main; why: --base overrides loop.json's base, print takes the summary, signal stops gates.
 */
async function check(app, { base, print, signal }) {
  const config = readConfig(app);
  const gates = await runGates(app, config.gates, { print, signal });
  if (signal?.aborted) return signal.reason === "SIGTERM" ? 143 : 130;

  const red = gates.filter((gate) => !gate.green);
  const ref = scanBase(app, { base, config: config.base });
  const scan = scanChange(app, { ref, wanted: base }, print);
  const current = [...red.map((gate) => gate.finding), ...scan.hits];
  const run = { sha: headSha(app), scanned: scan.ran, dirty: scan.ran && treeDirty(app) };
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
 * @param {{ ref: string | null, wanted?: string }} base - From scanBase and --base; why:
 *   where the change starts, and the exact ref asked for when git could not find it.
 * @param {(line: string) => void} print - From check; why: the base used, or the skip reason.
 */
function scanChange(app, { ref, wanted }, print) {
  const diff = ref ? changeDiff(app, ref) : null;
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

/** @param {string} app - From check; why: the commit where gone findings were fixed. */
function headSha(app) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: app, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}
