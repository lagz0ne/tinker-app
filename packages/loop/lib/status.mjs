import { readFindings, readLastCheck } from "./findings.mjs";
import { headSha } from "./git.mjs";
import { findingLine } from "./report.mjs";

/** A person checks the work when important findings are still open after this many reviews. */
export const reviewRoundsForPerson = 3;

/**
 * The stop rule. Done (0): the last check ran at HEAD with every gate green, and no important
 * finding is open. Needs a person (2): not done, important findings are open, and review has
 * run in 3 or more rounds. Else not done (1). Each open important finding gets one line,
 * then the verdict.
 * @param {string} app - From --app; why: whose loop state.
 */
export function loopStatus(app) {
  const findings = readFindings(app);
  const last = readLastCheck(app);
  const head = headSha(app);
  const open = findings.filter((f) => f.status === "open" && f.severity === "important");
  const reviews = new Set(findings.filter((f) => f.source === "review").map((f) => f.round));

  const reasons = [...checkReasons(last, head)];
  if (open.length > 0) reasons.push(`${count(open.length, "important finding")} open`);
  const lines = open.map((f) => `open important ${findingLine(f)}`);
  if (reasons.length === 0) {
    return {
      code: 0,
      lines: [...lines, `done: all gates green at ${short(head)}, no important finding open`],
    };
  }

  const person = open.length > 0 && reviews.size >= reviewRoundsForPerson;
  const verdict = person
    ? `needs a person: ${count(reviews.size, "review round")}, and ${count(open.length, "important finding")} still open`
    : `not done: ${reasons.join("; ")}`;
  return { code: person ? 2 : 1, lines: [...lines, verdict] };
}

/**
 * Why the last check does not count as green at HEAD.
 * @param {{ sha: string | null, gates: { name: string, green: boolean }[] } | null} last -
 *   From readLastCheck; why: what the last check saw.
 * @param {string | null} head - From git; why: a check before the latest commit is stale.
 */
function* checkReasons(last, head) {
  if (!last) {
    yield "no check has run; run tinker-loop check";
    return;
  }

  if (last.sha !== head) {
    yield `the last check ran at ${short(last.sha)}, but HEAD is ${short(head)}; run tinker-loop check`;
  }
  const red = last.gates.filter((gate) => !gate.green).map((gate) => gate.name);
  if (red.length > 0) yield `${count(red.length, "gate")} red in the last check: ${red.join(", ")}`;
}

/** @param {string | null} sha - From git or the last check; why: shown short, or "no commit". */
function short(sha) {
  return sha ? sha.slice(0, 12) : "no commit";
}

/**
 * @param {number} n - From a count; why: the number to show.
 * @param {string} noun - From the caller; why: made plural when n is not 1.
 */
function count(n, noun) {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
