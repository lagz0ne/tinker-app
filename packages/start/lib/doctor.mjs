import { boundary } from "./checks/boundary.mjs";
import { bytes } from "./checks/bytes.mjs";
import { env } from "./checks/env.mjs";
import { generated } from "./checks/generated.mjs";
import { breaksBuild, glue } from "./checks/glue.mjs";
import { imports } from "./checks/imports.mjs";
import { named } from "./checks/named.mjs";
import { routes } from "./checks/routes.mjs";
import { style } from "./checks/style.mjs";
import { version } from "./checks/version.mjs";

/** Doctor's checks, in the order it prints them (ADR 0106). */
export const checks = [
  { label: "base version", check: version },
  { label: "base bytes", check: bytes },
  { label: "generated folder", check: generated },
  { label: "glue", check: glue },
  { label: "named files", check: named },
  { label: "imports", check: imports },
  { label: "routes", check: routes },
  { label: "style", check: style },
  { label: "env", check: env },
  { label: "boundary", check: boundary },
];

/** Checks whose fail stops `vp build`: each is a mistake the build would ship in silence. */
const stopping = new Set(["named files", "imports", "routes", "style"]);

/** Checks a build reads too; their lines only warn, save a glue line that breaks the build. */
const warning = new Set(["base version", "glue"]);

/**
 * What tinker() runs at build start: doctor's own lines, so the build and doctor agree.
 * @param {string} root - From tinker(); why: the app being built.
 */
export function buildChecks(root) {
  const lines = checks
    .filter(({ label }) => stopping.has(label) || warning.has(label))
    .flatMap(({ label, check }) => {
      const result = check(root);
      if (result.status !== "fail") return [];
      return result.lines.map((line) => ({
        stops: stopping.has(label) || breaksBuild(line),
        text: `tinker doctor, ${label}: ${line}`,
      }));
    });
  return {
    errors: lines.filter(({ stops }) => stops).map(({ text }) => text),
    warnings: lines.filter(({ stops }) => !stops).map(({ text }) => text),
  };
}

/** @param {string} text - From a check; why: keep each printed line short for a phone. */
function wrap(text) {
  const lines = [""];
  for (const word of text.split(" ")) {
    const last = lines.length - 1;
    if (lines[last] && lines[last].length + word.length > 50) lines.push(word);
    else lines[last] = lines[last] ? `${lines[last]} ${word}` : word;
  }
  return lines.map((line) => `      ${line}`).join("\n");
}

/**
 * Run one check, and its fix when asked; a fix that leaves the check failing reports the fail.
 * @param {string} root - From doctor; why: the app to check.
 * @param {(root: string) => object} check - From the checks list; why: the check to run.
 * @param {boolean} fix - From --fix; why: repair base-owned and generated files only.
 */
export function runCheck(root, check, fix) {
  const result = check(root);
  if (!fix || !result.fix) return result;
  const note = result.fix();
  const again = check(root);
  return again.status === "ok" ? { status: "fixed", lines: [note] } : again;
}

/**
 * What `tinker doctor` prints, and its exit code: a status line per check, its findings
 * under it, then the total. Exit 1 on any fail.
 * @param {string} root - From the CLI; why: the app to check.
 * @param {boolean} fix - From --fix; why: repair base-owned and generated files only.
 */
export function doctor(root, fix) {
  const lines = [];
  let failed = 0;
  checks.forEach(({ label, check }, index) => {
    const result = runCheck(root, check, fix);
    if (result.status === "fail") failed += 1;
    lines.push(`${result.status.padEnd(5)} ${index + 1} ${label}`, ...result.lines.map(wrap));
  });
  lines.push(failed === 0 ? "doctor: all checks pass" : `doctor: ${failed} check(s) fail`);
  return { lines, code: failed === 0 ? 0 : 1 };
}
