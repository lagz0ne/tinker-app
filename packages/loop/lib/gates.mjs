import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { findingId, gateRule, loopFolder } from "./findings.mjs";
import { runProcess, timeoutProblem } from "./process.mjs";

const ansi = new RegExp(String.raw`\u001b\[[0-9;?]*[A-Za-z]`, "g");

/**
 * The app's loop.json, checked: its gates, its base branch, and its optional review block.
 * Throws a plain message on a bad file.
 * @param {string} app - From --app; why: loop.json sits in the app folder.
 */
export function readConfig(app) {
  const path = join(app, "loop.json");
  if (!existsSync(path)) throw new Error(`${path} is missing`);

  const config = JSON.parse(readFileSync(path, "utf8")) ?? {};
  const problem = configProblem(config) ?? reviewProblem(config.review);
  if (problem) throw new Error(`${path}: ${problem}`);
  return {
    gates: config.gates,
    base: typeof config.base === "string" ? config.base : null,
    review: config.review ?? {},
  };
}

/**
 * The optional `review` block: `command`, the reviewer's argv, and `timeout` in ms.
 * @param {unknown} review - From loop.json; why: the shape to check.
 */
function reviewProblem(review) {
  if (review === undefined) return null;
  if (!review || typeof review !== "object" || Array.isArray(review)) {
    return '"review" must be an object';
  }

  if (review.command !== undefined && !wordList(review.command)) {
    return '"review.command" must list the program and its arguments as strings';
  }
  const timeout = timeoutProblem(review.timeout);
  return timeout ? `"review.timeout" ${timeout}` : null;
}

/** @param {unknown} command - From loop.json; why: an argv must be words, the program first. */
function wordList(command) {
  return (
    Array.isArray(command) &&
    command.length > 0 &&
    command.every((word) => typeof word === "string" && word !== "")
  );
}

/** @param {{ gates?: unknown }} config - From loop.json; why: the shape to check. */
function configProblem({ gates }) {
  if (!Array.isArray(gates) || gates.length === 0) return '"gates" must list at least one gate';
  const bad = gates.map(gateProblem).find(Boolean);
  if (bad) return bad;

  if (new Set(gates.map((gate) => gate.name)).size !== gates.length) {
    return "gate names must differ";
  }
  return new Set(gates.map((gate) => logName(gate.name))).size === gates.length
    ? null
    : "gate names must differ after each character other than a letter, digit, '.', '_', or '-' becomes '-', since each names a log file";
}

/** @param {{ name?: unknown, run?: unknown, timeout?: unknown }} gate - From loop.json. */
function gateProblem(gate) {
  if (typeof gate?.name !== "string" || !gate.name || typeof gate.run !== "string") {
    return 'each gate needs a "name" and a "run" string';
  }

  const problem = timeoutProblem(gate.timeout);
  return problem ? `gate ${gate.name}: "timeout" ${problem}` : null;
}

/** @param {string} name - From loop.json; why: the gate's log file name. */
function logName(name) {
  return `${name.replaceAll(/[^\w.-]/g, "-")}.log`;
}

/**
 * The first line that reads like an error, else the first line, else the exit code.
 * @param {string} output - From the gate's log; why: the line to show the writer.
 * @param {string} ending - From runProcess; why: the fallback when the gate printed nothing.
 */
export function firstErrorLine(output, ending) {
  const lines = output
    .replaceAll(ansi, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const line =
    lines.find((text) => /error|fail|assert|not ok|✗|×/i.test(text)) ?? lines[0] ?? ending;
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

/**
 * Run every gate in order, all of them, even after a red one. Stops early only on `signal`.
 * Each gate's stdout and stderr go to one log, `.loop/gates/<name>.log`.
 * @param {string} app - From --app; why: gates run in the app folder.
 * @param {{ name: string, run: string, timeout?: number }[]} gates - From readConfig.
 * @param {{ print: (line: string) => void, signal?: AbortSignal }} run - From main; why: one
 *   progress line per gate, and the stop that kills the running gate.
 */
export async function runGates(app, gates, { print, signal }) {
  mkdirSync(join(loopFolder(app), "gates"), { recursive: true });

  const results = [];
  for (const gate of gates) {
    if (signal?.aborted) break;

    const log = join(".loop", "gates", logName(gate.name));
    const path = join(app, log);
    const ending = await runProcess(
      app,
      { command: gate.run, timeout: gate.timeout, out: path },
      signal,
    );
    print(`${ending ? "FAIL" : "PASS"} ${gate.name}`);
    results.push(ending ? redGate(app, gate, log, ending) : { name: gate.name, green: true });
  }

  return results;
}

/**
 * @param {string} app - From runGates; why: the log path is relative to it.
 * @param {{ name: string, run: string }} gate - From loop.json; why: names the finding.
 * @param {string} log - From runGates; why: the output to read and point at.
 * @param {string} ending - From runProcess; why: how the gate ended.
 */
function redGate(app, gate, log, ending) {
  const finding = {
    rule: gateRule,
    severity: "important",
    file: gate.name,
    line: null,
    summary: ending.startsWith("timed out")
      ? ending
      : firstErrorLine(readFileSync(join(app, log), "utf8"), ending),
    trigger: `\`${gate.run}\` ${ending}; full output in ${log}`,
    fix: `Make \`${gate.run}\` pass.`,
    source: "check",
  };
  const id = findingId({ source: "check", rule: gateRule, file: gate.name });
  return { name: gate.name, green: false, finding: { id, ...finding } };
}
