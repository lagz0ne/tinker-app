import { lockFindings as lockFile, recordReviewRound as recordRound } from "../lib/findings.mjs";

/**
 * The loop as the frozen tests see it (docs/decisions/loop-on-tinker.md, ticket 5). The tests
 * import only from here and from fixture.mjs, so the port changes this file, not their bodies.
 * Until ticket 8 it points at lib/; ticket 8 points it at the Tinker app.
 */
export { main } from "../lib/main.mjs";

/**
 * Take the findings lock. Async, as the port's store method is, so the tests await it now.
 * @param {string} app - From a test; why: the app whose findings file to lock.
 */
export async function lockFindings(app) {
  const release = lockFile(app);
  return async () => release();
}

/**
 * Record a review round. Async, as the port's store method is, so the tests await it now.
 * @param {string} app - From a test; why: the app whose rounds file to write.
 * @param {{ sha: string | null }} round - From a test; why: the commit the review saw.
 */
export async function recordReviewRound(app, round) {
  return recordRound(app, round);
}
