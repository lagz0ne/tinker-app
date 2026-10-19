import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { findingId, loopFolder } from "./findings.mjs";

const ansi = new RegExp(String.raw`\u001b\[[0-9;?]*[A-Za-z]`, "g");

/** A gate with no `timeout` in loop.json stops after 20 minutes. */
export const defaultTimeoutMs = 20 * 60 * 1000;

/**
 * The app's loop.json, checked. Throws a plain message on a bad file.
 * @param {string} app - From --app; why: loop.json sits in the app folder.
 */
export function readConfig(app) {
  const path = join(app, "loop.json");
  if (!existsSync(path)) throw new Error(`${path} is missing`);

  const config = JSON.parse(readFileSync(path, "utf8"));
  const problem = configProblem(config ?? {});
  if (problem) throw new Error(`${path}: ${problem}`);
  return { gates: config.gates, base: typeof config.base === "string" ? config.base : null };
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

  const { timeout } = gate;
  return timeout === undefined || (Number.isSafeInteger(timeout) && timeout > 0)
    ? null
    : `gate ${gate.name}: "timeout" must be a positive whole number of milliseconds`;
}

/** @param {string} name - From loop.json; why: the gate's log file name. */
function logName(name) {
  return `${name.replaceAll(/[^\w.-]/g, "-")}.log`;
}

/**
 * The first line that reads like an error, else the first line, else the exit code.
 * @param {string} output - From the gate's log; why: the line to show the writer.
 * @param {string} ending - From runGate; why: the fallback when the gate printed nothing.
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
    const ending = await runGate(app, gate, join(app, log), signal);
    print(`${ending ? "FAIL" : "PASS"} ${gate.name}`);
    results.push(ending ? redGate(app, gate, log, ending) : { name: gate.name, green: true });
  }

  return results;
}

/**
 * @param {string} app - From runGates; why: the log path is relative to it.
 * @param {{ name: string, run: string }} gate - From loop.json; why: names the finding.
 * @param {string} log - From runGates; why: the output to read and point at.
 * @param {string} ending - From runGate; why: how the gate ended.
 */
function redGate(app, gate, log, ending) {
  const finding = {
    rule: "G1",
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
  const id = findingId({ source: "check", rule: "G1", file: gate.name });
  return { name: gate.name, green: false, finding: { id, ...finding } };
}

/**
 * Run one gate in a shell, in its own process group. On its timeout or on `signal`, the whole
 * group is killed, so no child of the gate lives on. Resolves null when it passed, else how
 * it ended.
 * @param {string} app - From runGates; why: the gate's working folder.
 * @param {{ run: string, timeout?: number }} gate - From loop.json; why: the command.
 * @param {string} log - From runGates; why: where its output goes.
 * @param {AbortSignal | undefined} signal - From main; why: a stop kills the gate.
 */
function runGate(app, gate, log, signal) {
  const out = openSync(log, "w");
  const timeout = gate.timeout ?? defaultTimeoutMs;

  return new Promise((resolve) => {
    let ending = null;
    const child = spawn(gate.run, {
      cwd: app,
      shell: true,
      detached: true,
      stdio: ["ignore", out, out],
    });
    const stop = (why) => {
      ending ??= why;
      killGroup(child.pid);
    };
    const timer = setTimeout(() => stop(`timed out after ${timeout} ms`), timeout);
    const abort = () => stop("was stopped");
    signal?.addEventListener("abort", abort, { once: true });

    let finished = false;
    const done = (end) => {
      if (finished) return;

      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      closeSync(out);
      resolve(ending ?? end);
    };
    child.once("error", (error) => done(`could not start: ${error.message}`));
    child.once("close", (code, killed) => {
      if (code === 0) done(null);
      else done(killed ? `was stopped by ${killed}` : `exited with code ${code}`);
    });
  });
}

/** @param {number | undefined} pid - From spawn; why: the group leader to kill. */
function killGroup(pid) {
  try {
    if (pid) process.kill(-pid, "SIGKILL");
  } catch {
    // The group already ended.
  }
}
