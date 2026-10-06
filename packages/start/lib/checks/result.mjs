/**
 * A check's result: `lines` are what doctor prints, one finding per line.
 * A fail may carry `fix`, which repairs only base-owned or generated files (ADR 0106).
 */
export const ok = (line) => ({ status: "ok", lines: [line] });
export const skip = (line) => ({ status: "skip", lines: [line] });
export const fail = (lines, fix) => ({ status: "fail", lines, fix });

/**
 * @param {string[]} problems - From a check; why: any problem fails it.
 * @param {string} passed - From a check; why: the line printed when it passes.
 * @param {() => string} [fix] - From a check; why: the repair, when one exists.
 */
export function verdict(problems, passed, fix) {
  return problems.length > 0 ? fail(problems, fix) : ok(passed);
}
