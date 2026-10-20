import { readFindings, readLastCheck, readRounds } from "./findings.mjs";
import { headSha } from "./git.mjs";
import { findingLine } from "./report.mjs";
import { treeState } from "./scan.mjs";

/** A person checks the work when review findings are still open after this many reviews. */
export const reviewRoundsForPerson = 3;

/**
 * The stop rule. Done (0): the last check ran at HEAD on the same work tree as now, every gate
 * was green, and no important finding is open. Needs a person (2): not done, an important
 * review finding is open, and `.loop/rounds.jsonl` records 3 or more review rounds. Else not
 * done (1). Each open important finding gets one line, then the verdict.
 * @param {string} app - From --app; why: whose loop state.
 */
export function loopStatus(app) {
  const findings = readFindings(app);
  const last = readLastCheck(app);
  const head = headSha(app);
  const tree = last && last.sha === head ? treeState(app).fingerprint : null;
  const open = findings.filter((f) => f.status === "open" && f.severity === "important");
  const reviewOpen = open.filter((f) => f.source === "review");
  const rounds = new Set(
    readRounds(app)
      .filter((r) => r.source === "review")
      .map((r) => r.round),
  );

  const reasons = [...checkReasons(last, { head, tree })];
  if (open.length > 0) reasons.push(`${count(open.length, "important finding")} open`);
  const lines = open.map((f) => `open important ${findingLine(f)}`);
  if (reasons.length === 0) {
    return {
      code: 0,
      lines: [...lines, `done: all gates green at ${short(head)}, no important finding open`],
    };
  }

  const person = reviewOpen.length > 0 && rounds.size >= reviewRoundsForPerson;
  const verdict = person
    ? `needs a person: ${count(rounds.size, "review round")}, and ${count(reviewOpen.length, "important review finding")} still open`
    : `not done: ${reasons.join("; ")}`;
  return { code: person ? 2 : 1, lines: [...lines, verdict] };
}

/**
 * Why the last check does not count as green for the work tree as it is now.
 * @param {{ sha: string | null, tree?: string | null,
 *   gates: { name: string, green: boolean }[] } | null} last - From readLastCheck; why: what
 *   the last check saw.
 * @param {{ head: string | null, tree: string | null }} now - From git; why: a check before
 *   the latest commit, or before later edits, is stale.
 */
function* checkReasons(last, now) {
  if (!last) {
    yield "no check has run; run tinker-loop check";
    return;
  }

  if (last.sha !== now.head) {
    yield `the last check ran at ${short(last.sha)}, but HEAD is ${short(now.head)}; run tinker-loop check`;
  } else if (last.tree !== now.tree) {
    yield "the tree changed since the last check; run tinker-loop check";
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
