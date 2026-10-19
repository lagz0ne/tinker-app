import { updateFindings } from "./findings.mjs";
import { commitSha, headSha, inHistory } from "./git.mjs";

/**
 * Mark one finding fixed at a commit, or answered with a reason, under the findings lock.
 * The row stays in the file. Returns null when it is done, else why it was refused.
 * @param {string} app - From --app; why: whose findings, and the repo of the fix.
 * @param {string} id - From the command line; why: the finding to answer.
 * @param {{ fixed: string, named?: boolean } | { reason: string }} answer - From the command
 *   line; why: the fix commit's full sha and whether --sha named it, or the reason it stays.
 */
export function answerFinding(app, id, answer) {
  let refused = null;
  updateFindings(app, (findings) => {
    const row = findings.find((finding) => finding.id === id);
    refused = row ? fixProblem(app, row, answer) : `no finding has id ${id}`;
    if (refused) return findings;

    return findings.map((finding) => (finding === row ? answered(row, answer) : finding));
  });

  return refused;
}

/**
 * The fix commit must be in HEAD's history and come after `seenSha`, the HEAD commit when a
 * tool last saw the finding. A row with no `seenSha` takes only a fix named with --sha, since
 * no tool recorded where it was seen. A `seenSha` that left HEAD's history, after an amend or
 * a rebase, needs the tool to see the finding again.
 * @param {string} app - From answerFinding; why: the repo to ask.
 * @param {{ id: string, seenSha?: string }} row - From the file; why: where it was seen.
 * @param {{ fixed?: string, named?: boolean }} answer - From answerFinding; why: the fix
 *   commit, if any, and whether --sha named it.
 */
function fixProblem(app, row, { fixed, named = false }) {
  if (!fixed) return null;

  const head = headSha(app) ?? "HEAD";
  if (!inHistory(app, fixed, head)) return `commit ${short(fixed)} is not in HEAD's history`;
  if (!row.seenSha) {
    return named
      ? null
      : `finding ${row.id} has no seenSha, so no tool recorded where it was seen; name the fix commit with --sha`;
  }
  return seenProblem(app, row, fixed, head);
}

/**
 * @param {string} app - From fixProblem; why: the repo to ask.
 * @param {{ id: string, seenSha: string }} row - From fixProblem; why: where it was seen.
 * @param {string} fixed - From fixProblem; why: the fix commit.
 * @param {string} head - From fixProblem; why: the history the finding must still be in.
 */
function seenProblem(app, row, fixed, head) {
  if (!inHistory(app, row.seenSha, head)) {
    return `finding ${row.id} was seen at ${short(row.seenSha)}, which is no longer in HEAD's history (amended or rebased); run tinker-loop check, or the tool that saw it, again`;
  }
  if (fixed === row.seenSha || !inHistory(app, row.seenSha, fixed)) {
    return `finding ${row.id} was seen at ${short(row.seenSha)}; commit the fix after it, then answer`;
  }
  return null;
}

/** @param {string} sha - From git; why: shown short in a message. */
function short(sha) {
  return sha.slice(0, 12);
}

/**
 * @param {object} row - From the file; why: the finding to change.
 * @param {{ fixed?: string, reason?: string }} answer - From answerFinding; why: the change.
 */
function answered(row, answer) {
  const { sha: _sha, dirty: _dirty, ...kept } = row;
  return answer.fixed
    ? { ...kept, status: "fixed", sha: answer.fixed }
    : { ...kept, status: "answered", reason: answer.reason };
}

/**
 * The full sha of the fix commit: `--sha`, or HEAD. Null when it names no commit.
 * @param {string} app - From --app; why: the repo to ask.
 * @param {string | undefined} ref - From --sha; why: the commit with the fix.
 */
export function fixCommit(app, ref) {
  return commitSha(app, ref ?? "HEAD");
}
