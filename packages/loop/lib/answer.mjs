import { updateFindings } from "./findings.mjs";
import { commitSha, headSha, inHistory } from "./git.mjs";

/**
 * Mark one finding fixed at a commit, or answered with a reason, under the findings lock.
 * The row stays in the file. Returns null when it is done, else why it was refused.
 * @param {string} app - From --app; why: whose findings, and the repo of the fix.
 * @param {string} id - From the command line; why: the finding to answer.
 * @param {{ fixed: string } | { reason: string }} answer - From the command line; why: the
 *   fix commit's full sha, or the reason the finding stays.
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
 * The fix commit must be in HEAD's history and come after the commit that saw the finding.
 * A row with no `seenSha` (one that check did not write) needs only the first.
 * @param {string} app - From answerFinding; why: the repo to ask.
 * @param {{ id: string, seenSha?: string }} row - From the file; why: where it was seen.
 * @param {{ fixed?: string }} answer - From answerFinding; why: the fix commit, if any.
 */
function fixProblem(app, row, { fixed }) {
  if (!fixed) return null;

  const short = (sha) => sha.slice(0, 12);
  if (!inHistory(app, fixed, headSha(app) ?? "HEAD")) {
    return `commit ${short(fixed)} is not in HEAD's history`;
  }
  if (row.seenSha && (fixed === row.seenSha || !inHistory(app, row.seenSha, fixed))) {
    return `finding ${row.id} was seen at ${short(row.seenSha)}; commit the fix after it, then answer`;
  }
  return null;
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
