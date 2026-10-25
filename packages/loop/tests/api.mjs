import { createScope } from "@tinker/core";

import { findingsLock } from "@/resources/findings-lock";
import { store } from "@/resources/store";
import { appDir } from "@/tags";

// oxlint-disable-next-line import/no-relative-parent-imports -- The tests drive the app's own command.
import cli from "../cmds/cli";

/**
 * The loop as the frozen tests see it (docs/decisions/loop-on-tinker.md, ticket 5). The tests
 * import only from here and from fixture.mjs, so the port changes this file, not their bodies.
 * Since ticket 8 it drives the app: `main` runs cmds/cli.ts in process, as runMain would, and
 * the store helpers open a scope with the store resource.
 */

/**
 * Run one tinker-loop command line through the app's command, and return its exit code.
 * @param {{ args: string[], cwd: string, stdout: { write(chunk: string): unknown },
 *   stderr: { write(chunk: string): unknown }, signal?: AbortSignal }} run - From a test.
 */
export async function main({ args, cwd, stdout, stderr, signal }) {
  let code;
  const done = await cli({
    env: process.env,
    args,
    cwd,
    stdout,
    stderr,
    signal: signal ?? new AbortController().signal,
    exit: (next) => {
      code ??= next;
    },
  });
  await done.closed;
  return code;
}

/**
 * Take the findings lock, as the operations take it. Resolves once the lock is held, with its
 * release.
 * @param {string} app - From a test; why: the app whose findings file to lock.
 */
export async function lockFindings(app) {
  const scope = createScope({ tags: [appDir(app)] });
  const lock = scope.resolve(findingsLock);
  const token = await lock.take();
  return async () => {
    lock.release(token);
    await scope.close();
  };
}

/**
 * Record a review round as the review operation does: under the findings lock, one more than any
 * round in the findings, the review rounds, or the last check. Returns its number.
 * @param {string} app - From a test; why: the app whose rounds file to write.
 * @param {{ sha: string | null }} round - From a test; why: the commit the review saw.
 */
export async function recordReviewRound(app, { sha }) {
  const scope = createScope({ tags: [appDir(app)] });
  const files = scope.resolve(store);
  const lock = scope.resolve(findingsLock);
  const token = await lock.take();
  try {
    const round = files.nextRound();
    files.appendRound({ round, source: "review", sha });
    return round;
  } finally {
    lock.release(token);
    await scope.close();
  }
}
