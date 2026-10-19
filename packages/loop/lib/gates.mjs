import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { findingId, loopFolder } from "./findings.mjs";

const ansi = new RegExp(String.raw`\u001b\[[0-9;?]*[A-Za-z]`, "g");

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
  if (gates.some((gate) => typeof gate?.name !== "string" || typeof gate?.run !== "string")) {
    return 'each gate needs a "name" and a "run" string';
  }

  const names = new Set(gates.map((gate) => gate.name));
  return names.size === gates.length ? null : "gate names must differ";
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
 * Run every gate in order, all of them, even after a red one.
 * Each gate's stdout and stderr go to one log, `.loop/gates/<name>.log`.
 * @param {string} app - From --app; why: gates run in the app folder.
 * @param {{ name: string, run: string, timeout?: number }[]} gates - From readConfig.
 * @param {(line: string) => void} print - From main; why: one progress line per gate.
 */
export function runGates(app, gates, print) {
  mkdirSync(join(loopFolder(app), "gates"), { recursive: true });

  return gates.map((gate) => {
    const log = join(".loop", "gates", `${gate.name.replaceAll(/[^\w.-]/g, "-")}.log`);
    const ending = runGate(app, gate, join(app, log));
    print(`${ending ? "FAIL" : "PASS"} ${gate.name}`);
    if (!ending) return { name: gate.name, green: true };

    const finding = {
      rule: "G1",
      severity: "important",
      file: gate.name,
      line: null,
      summary: firstErrorLine(readFileSync(join(app, log), "utf8"), ending),
      trigger: `\`${gate.run}\` ${ending}; full output in ${log}`,
      fix: `Make \`${gate.run}\` pass.`,
      source: "check",
    };
    return { name: gate.name, green: false, finding: { id: findingId(finding), ...finding } };
  });
}

/**
 * Run one gate in a shell. Returns null when it passed, else how it ended.
 * @param {string} app - From runGates; why: the gate's working folder.
 * @param {{ run: string, timeout?: number }} gate - From loop.json; why: the command.
 * @param {string} log - From runGates; why: where its output goes.
 */
function runGate(app, gate, log) {
  const out = openSync(log, "w");
  try {
    const result = spawnSync(gate.run, {
      cwd: app,
      shell: true,
      stdio: ["ignore", out, out],
      timeout: gate.timeout,
    });
    if (result.signal) return `was stopped by ${result.signal}`;
    if (result.error) return `could not start: ${result.error.message}`;

    return result.status === 0 ? null : `exited with code ${result.status}`;
  } finally {
    closeSync(out);
  }
}
