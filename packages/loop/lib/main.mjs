import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { mergeCheck, nextRound, readFindings, updateFindings } from "./findings.mjs";
import { readConfig, runGates } from "./gates.mjs";
import { findingList, ruleLines, summary } from "./report.mjs";
import { readRules } from "./rules.mjs";
import { changeDiff, scanBase, scanDiff, treeBefore } from "./scan.mjs";

/** The exit code for each stop the bin passes on: 128 plus the signal's number. */
const stopCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

const usage = [
  "usage: tinker-loop check [--app <dir>] [--base <ref>]",
  "       tinker-loop findings [--app <dir>] [--open] [--rules]",
  "       tinker-loop rules [ID...] [--app <dir>]",
].join("\n");

/** Each command: the flags it takes, and its call with the app folder and the command line. */
const commands = {
  check: {
    flags: ["app", "base"],
    run: (app, { options, print, signal }) => check(app, { base: options.base, print, signal }),
  },
  findings: {
    flags: ["app", "open", "rules"],
    run: (app, { options, print }) => findings(app, options, print),
  },
  rules: {
    flags: ["app"],
    ids: true,
    run: (app, { positionals, print, stderr }) => rules(app, positionals, { print, stderr }),
  },
};

/**
 * Run one tinker-loop command. Returns the exit code: 0 done, 1 a red gate,
 * 64 bad arguments or an unknown rule, 78 a bad loop.json, findings file, or Start install,
 * 129, 130, or 143 when stopped.
 * @param {{ args: readonly string[], cwd: string, stdout: { write(chunk: string): unknown },
 *   stderr: { write(chunk: string): unknown }, signal?: AbortSignal }} context - From the bin
 *   or a test; why: the command line, the folder it runs from, where to print, and the stop.
 */
export async function main({ args, cwd, stdout, stderr, signal }) {
  const [command, ...rest] = args;
  const print = (line) => stdout.write(`${line}\n`);
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        app: { type: "string" },
        base: { type: "string" },
        open: { type: "boolean" },
        rules: { type: "boolean" },
      },
    });
  } catch (error) {
    stderr.write(`${error.message}\n${usage}\n`);
    return 64;
  }

  const { values: options, positionals } = parsed;
  const problem = commandProblem(command, Object.keys(options), positionals);
  if (problem !== null) {
    stderr.write(`${problem}${usage}\n`);
    return 64;
  }

  try {
    const app = resolve(cwd, options.app ?? ".");
    return await commands[command].run(app, { options, positionals, print, stderr, signal });
  } catch (error) {
    stderr.write(`tinker-loop: ${error.message}\n`);
    return 78;
  }
}

/**
 * Why the command line does not fit the command: an empty string for an unknown command,
 * a message for a flag or ID it does not take, or null when it fits.
 * @param {string | undefined} command - From the command line; why: the command asked for.
 * @param {string[]} flags - From parseArgs; why: the flags given.
 * @param {string[]} positionals - From parseArgs; why: only rules takes IDs.
 */
function commandProblem(command, flags, positionals) {
  if (!command || !Object.hasOwn(commands, command)) return "";

  const { flags: takes, ids = false } = commands[command];
  const extra = flags.find((flag) => !takes.includes(flag));
  if (extra) return `tinker-loop ${command} does not take --${extra}\n`;
  return positionals.length > 0 && !ids ? `tinker-loop ${command} takes no IDs\n` : null;
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
 * Print the findings file as a list, with each finding's rule text when asked.
 * @param {string} app - From --app; why: whose findings, and whose Start rules.
 * @param {{ open?: boolean, rules?: boolean }} options - From --open and --rules; why: show
 *   only open findings, and add the rule text from the app's own Start.
 * @param {(line: string) => void} print - From main; why: where the list goes.
 */
function findings(app, options, print) {
  const book = options.rules ? readRules(app).rules : null;
  const all = readFindings(app);
  const shown = options.open ? all.filter((f) => f.status === "open") : all;
  for (const line of findingList(shown, book)) print(line);
  return 0;
}

/**
 * Print the asked rules, or all of them, from the Start that the app resolves.
 * @param {string} app - From --app; why: Node finds @tinker/start from here.
 * @param {string[]} ids - From the command line; why: the rules to print; none means all.
 * @param {{ print: (line: string) => void, stderr: { write(chunk: string): unknown } }} out -
 *   From main; why: rules go to stdout, an unknown ID goes to stderr.
 */
function rules(app, ids, { print, stderr }) {
  const book = readRules(app);
  const wanted = [...new Set(ids.map((id) => id.toUpperCase()))];
  const unknown = wanted.filter((id) => !book.rules.some((rule) => rule.id === id));
  if (unknown.length > 0) {
    const known = book.rules.map((rule) => rule.id).join(", ");
    stderr.write(`tinker-loop: unknown rule ${unknown.join(", ")}; known rules: ${known}\n`);
    return 64;
  }

  print(`@tinker/start ${book.version}: ${book.path}`);
  for (const line of ruleLines(book.rules, wanted)) print(line);
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
