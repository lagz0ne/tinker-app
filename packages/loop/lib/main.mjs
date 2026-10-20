import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { answerFinding, fixCommit } from "./answer.mjs";
import {
  loopFolder,
  mergeCheck,
  nextRound,
  readFindings,
  readLastCheck,
  readRounds,
  updateFindings,
  writeLastCheck,
} from "./findings.mjs";
import { readConfig, runGates } from "./gates.mjs";
import { headSha } from "./git.mjs";
import { findingList, ruleLines, summary } from "./report.mjs";
import { runReview } from "./review.mjs";
import { readRules } from "./rules.mjs";
import { changeDiff, scanBase, scanDiff, treeState } from "./scan.mjs";
import { loopStatus } from "./status.mjs";

/** The exit code for each stop the bin passes on: 128 plus the signal's number. */
const stopCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

const usage = [
  "usage: tinker-loop check [--app <dir>] [--base <ref>]",
  "       tinker-loop findings [--app <dir>] [--open] [--rules]",
  "       tinker-loop rules [ID...] [--app <dir>]",
  '       tinker-loop answer <ID> (--fixed [--sha <sha>] | --reason "<text>") [--app <dir>]',
  "       tinker-loop status [--app <dir>]",
  "       tinker-loop review [--app <dir>] [--base <ref>]",
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
    ids: "any",
    run: (app, { positionals, print, stderr }) => rules(app, positionals, { print, stderr }),
  },
  answer: {
    flags: ["app", "fixed", "sha", "reason"],
    ids: "one",
    run: (app, { positionals, options, print, stderr }) =>
      answer(app, positionals[0], options, { print, stderr }),
  },
  status: {
    flags: ["app"],
    run: (app, { print }) => status(app, print),
  },
  review: {
    flags: ["app", "base"],
    run: (app, { options, print, stderr, signal }) =>
      review(app, { base: options.base, print, stderr, signal }),
  },
};

/**
 * Run one tinker-loop command. Returns the exit code: 0 done, 1 a red gate, not done, or a
 * failed reviewer, 2 needs a person, 64 bad arguments, an unknown rule or ID, or a refused answer,
 * 78 a bad loop.json, findings file, or Start install, 129, 130, or 143 when stopped.
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
        fixed: { type: "boolean" },
        sha: { type: "string" },
        reason: { type: "string" },
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
 * @param {string[]} positionals - From parseArgs; why: rules takes IDs, answer takes one.
 */
function commandProblem(command, flags, positionals) {
  if (!command || !Object.hasOwn(commands, command)) return "";

  const { flags: takes, ids = "none" } = commands[command];
  const extra = flags.find((flag) => !takes.includes(flag));
  if (extra) return `tinker-loop ${command} does not take --${extra}\n`;
  return idsProblem(command, ids, positionals.length);
}

/**
 * @param {string} command - From commandProblem; why: names the command in the message.
 * @param {string} ids - From the command table: "any", "one", or "none".
 * @param {number} count - From the command line; why: how many IDs were given.
 */
function idsProblem(command, ids, count) {
  if (ids === "one" && count !== 1) return `tinker-loop ${command} takes one finding ID\n`;
  return count > 0 && ids === "none" ? `tinker-loop ${command} takes no IDs\n` : null;
}

/**
 * Run every gate, scan the change, merge into the findings file, and print the summary.
 * A run stopped before the write leaves the findings file as it was. Dirty state and untracked
 * files are read before the gates, so files the gates write are not part of the change. The
 * saved tree fingerprint is taken after the gates, so files they write do not block done.
 * @param {string} app - From --app; why: the app to check.
 * @param {{ base?: string, print: (line: string) => void, signal?: AbortSignal }} run - From
 *   main; why: --base overrides loop.json's base, print takes the summary, signal stops gates.
 */
async function check(app, { base, print, signal }) {
  const config = readConfig(app);
  loopFolder(app);
  const before = treeState(app);
  const gates = await runGates(app, config.gates, { print, signal });
  if (stopCode(signal)) return stopCode(signal);

  const red = gates.filter((gate) => !gate.green);
  const ref = scanBase(app, { base, config: config.base });
  const scan = scanChange(app, { ref, wanted: base, untracked: before.untracked }, print);
  const current = [...red.map((gate) => gate.finding), ...scan.hits];
  const run = { sha: headSha(app), scanned: scan.ran, dirty: before.dirty };
  const after = treeState(app).fingerprint;
  if (stopCode(signal)) return stopCode(signal);

  let round = 0;
  const merged = updateFindings(app, (previous) => {
    round = nextRound([...previous, ...readRounds(app), lastCheckRound(app)]);
    return mergeCheck(previous, current, { ...run, round });
  });
  const results = gates.map(({ name, green }) => ({ name, green }));
  writeLastCheck(app, { round, sha: run.sha, tree: after, gates: results });

  print(
    `tinker-loop check, round ${round}: ${gates.length - red.length} gates green, ${red.length} red`,
  );
  for (const line of summary(merged)) print(line);
  return red.length > 0 ? 1 : 0;
}

/**
 * The last check's round, for the next round number. A broken last-check.json counts as none,
 * since this check writes it again.
 * @param {string} app - From check; why: whose loop state.
 */
function lastCheckRound(app) {
  try {
    return readLastCheck(app) ?? {};
  } catch {
    return {};
  }
}

/**
 * Scan the change from `ref`. When it cannot run, it says why, and its rows stay as they are.
 * @param {string} app - From --app; why: the folder to scan.
 * @param {{ ref: string | null, wanted?: string, untracked: string[] | null }} base - From
 *   scanBase, --base, and treeState; why: where the change starts, the exact ref asked for
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
 * Mark a finding fixed or answered. A refusal exits 64 and says why.
 * @param {string} app - From --app; why: whose findings, and the repo of the fix.
 * @param {string} id - From the command line; why: the finding to answer.
 * @param {{ fixed?: boolean, sha?: string, reason?: string }} options - From the command line;
 *   why: --fixed with an optional --sha, or --reason with its text.
 * @param {{ print: (line: string) => void, stderr: { write(chunk: string): unknown } }} out -
 *   From main; why: the result goes to stdout, a refusal to stderr.
 */
function answer(app, id, options, { print, stderr }) {
  const result = answerProblem(options) ?? recordAnswer(app, id, options);
  if (result.refused) {
    stderr.write(`tinker-loop answer: ${result.refused}\n`);
    return 64;
  }

  print(result.done);
  return 0;
}

/**
 * @param {{ fixed?: boolean, sha?: string, reason?: string }} options - From answer; why: the
 *   flags must ask for one clear answer.
 */
function answerProblem({ fixed = false, sha, reason }) {
  if (fixed === (reason !== undefined)) return { refused: "give --fixed or --reason, one of them" };
  if (sha !== undefined && !fixed) return { refused: "--sha goes with --fixed" };
  return reason !== undefined && !reason.trim() ? { refused: "--reason needs text" } : null;
}

/**
 * Write the answer. Returns why it was refused, or the line to print when it is done.
 * @param {string} app - From answer; why: whose findings, and the repo of the fix.
 * @param {string} id - From answer; why: the finding to answer.
 * @param {{ fixed?: boolean, sha?: string, reason?: string }} options - From answer; why: the
 *   checked flags.
 */
function recordAnswer(app, id, options) {
  if (!options.fixed) {
    const reason = options.reason.trim();
    return { refused: answerFinding(app, id, { reason }), done: `answered ${id}: ${reason}` };
  }

  const fixed = fixCommit(app, options.sha);
  if (!fixed) return { refused: `${options.sha ?? "HEAD"} is not a commit` };
  const named = options.sha !== undefined;
  return {
    refused: answerFinding(app, id, { fixed, named }),
    done: `fixed ${id} at ${fixed.slice(0, 12)}`,
  };
}

/**
 * Run the reviewer model on the change and merge its findings as one review round.
 * @param {string} app - From --app; why: the app to review.
 * @param {{ base?: string, print: (line: string) => void,
 *   stderr: { write(chunk: string): unknown }, signal?: AbortSignal }} run - From main; why:
 *   --base overrides loop.json's base; print, stderr, and the stop.
 */
async function review(app, { base, print, stderr, signal }) {
  const config = readConfig(app);
  const code = await runReview(app, { base, config, print, stderr, signal });
  return stopCode(signal) || code;
}

/**
 * Print each open important finding and the verdict of the stop rule.
 * @param {string} app - From --app; why: whose loop state.
 * @param {(line: string) => void} print - From main; why: where the lines go.
 */
function status(app, print) {
  const { code, lines } = loopStatus(app);
  for (const line of lines) print(line);
  return code;
}

/**
 * The exit code of a stopped run, or 0 while it runs.
 * @param {AbortSignal | undefined} signal - From main; why: its reason names the signal.
 */
function stopCode(signal) {
  return signal?.aborted ? (stopCodes[signal.reason] ?? 130) : 0;
}
