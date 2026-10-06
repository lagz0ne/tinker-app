import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { appFiles, shellFile } from "./named.mjs";

/** @param {string} root - From a violation hook; why: the app's generated folder. */
function writeViolations(root, found) {
  mkdirSync(join(root, ".tinker"), { recursive: true });
  writeFileSync(
    join(root, ".tinker/violations.json"),
    JSON.stringify([...found.values()], null, 2) + "\n",
  );
}

/**
 * Start a build's boundary record: empty, written only when a real build starts its import
 * analysis. Loading tinker() (prepare, dev, tests, --fix) never touches the last build's record.
 * @param {string} root - From tinker()'s build start; why: the app being built.
 */
export function startViolations(root) {
  const found = new Map();
  writeViolations(root, found);
  return found;
}

/**
 * Keep one import boundary violation for doctor check 10; Start's own error stops at the first.
 * @param {string} root - From tinker(); why: importer paths are relative to the app.
 * @param {Map<string, object>} found - From startViolations; why: this build's record.
 * @param {{ importer: string, importerLoc?: { line: number, column: number }, specifier: string, envType: string, pattern?: RegExp | string, type?: string }} info - From Start's onViolation; why: one violation.
 */
export function recordViolation(root, found, info) {
  const at = info.importerLoc ? `:${info.importerLoc.line}:${info.importerLoc.column}` : "";
  const importer = `${relative(root, info.importer)}${at}`;
  found.set(`${importer} ${info.specifier}`, {
    env: info.envType,
    importer,
    specifier: info.specifier,
    rule: String(info.pattern ?? info.type),
  });
  writeViolations(root, found);
}

/**
 * The dev restart rule: Start reads the shell, the named files, and the seam files once, at
 * config time, so adding or removing one needs a restart. The line to log, or null.
 * @param {string} root - From tinker()'s dev server; why: the picked files live there.
 * @param {string} path - From Vite's watcher; why: the file that came or went.
 * @param {"added" | "removed"} verb - From Vite's watcher; why: what happened to it.
 */
export function restartNote(root, path, verb) {
  const picked = [shellFile, ...appFiles.map(({ file }) => file)].map((file) => join(root, file));
  return picked.includes(path) ? `tinker: ${relative(root, path)} ${verb}; restarting` : null;
}
