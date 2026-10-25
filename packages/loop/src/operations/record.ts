import { operation } from "@tinker/core";
import { z } from "zod";

import { findingsLock } from "@/resources/findings-lock";
import { git } from "@/resources/git";
import { finding, store } from "@/resources/store";
import { stop } from "@/tags";

/**
 * Merge one check run into the findings file under the lock, at the next round. A finding seen
 * again keeps its id and an answer's reason, and a fixed one opens again; a check finding that
 * is gone becomes fixed when this run checked it; scan rows change only when the scan ran;
 * judge and review findings stay. Null when a stop came first: then nothing is written.
 */
export const recordCheck = operation({
  label: "loop.recordCheck",
  input: z.object({
    found: z.array(finding),
    sha: z.string().nullable(),
    scanned: z.boolean(),
    dirty: z.boolean(),
  }),
  depends: { store, findingsLock, stop },
  run: async ({ store: files, findingsLock: lock, stop: signal }, { input }) => {
    // A stop while another tool holds the lock ends the wait: then this run is stopped.
    const token = await lock.take(signal).catch((error: unknown) => {
      if (signal.aborted) return null;
      throw error;
    });
    if (!token) return null;

    try {
      // A stop can land just as the lock is taken; then this run writes nothing.
      if (signal.aborted) return null;
      const round = files.nextRound();
      const stamp = { round, sha: input.sha, dirty: input.dirty };
      const found = new Map(input.found.map((row) => [row.id, row]));

      const merged = files.findings().map((old) => {
        const now = found.get(old.id);
        found.delete(old.id);
        if (now) return files.seen(old, now, stamp);

        const checked = old.source === "check" && (old.rule === "G1" || input.scanned);
        return !checked || old.status === "fixed" ? old : files.fixed(old, stamp);
      });
      const next = [...merged, ...[...found.values()].map((row) => files.opened(row, stamp))];
      files.writeFindings(next);
      return { round, merged: next };
    } finally {
      lock.release(token);
    }
  },
});

/**
 * Record one review round under the lock: its row in rounds.jsonl, and its findings merged. A
 * reported finding opens or is seen again; an open review finding the reviewer rechecked as
 * fixed becomes fixed. Null when a stop came first: then nothing is written.
 */
export const recordReview = operation({
  label: "loop.recordReview",
  input: z.object({
    reported: z.array(finding),
    fixed: z.array(z.string()),
    sha: z.string().nullable(),
    dirty: z.boolean(),
  }),
  depends: { store, findingsLock, stop },
  run: async ({ store: files, findingsLock: lock, stop: signal }, { input }) => {
    // A stop while another tool holds the lock ends the wait: then this run is stopped.
    const token = await lock.take(signal).catch((error: unknown) => {
      if (signal.aborted) return null;
      throw error;
    });
    if (!token) return null;

    try {
      // A stop can land just as the lock is taken; then this run records nothing.
      if (signal.aborted) return null;
      const round = files.nextRound();
      files.appendRound({ round, source: "review", sha: input.sha });
      const stamp = { round, sha: input.sha, dirty: input.dirty };
      const byId = new Map(input.reported.map((row) => [row.id, row]));

      const merged = files.findings().map((old) => {
        const now = byId.get(old.id);
        byId.delete(old.id);
        if (now) return files.seen(old, now, stamp);

        const open = old.source === "review" && old.status === "open";
        return open && input.fixed.includes(old.id) ? files.fixed(old, stamp) : old;
      });
      const next = [...merged, ...[...byId.values()].map((row) => files.opened(row, stamp))];
      files.writeFindings(next);
      return { round, merged: next };
    } finally {
      lock.release(token);
    }
  },
});

/**
 * Answer one finding under the lock: fixed at the commit `at` names, or answered with a reason
 * when `at` is null. The row stays in the file, without what a check saw of it. Returns why it
 * was refused, or the fix commit (null for an answer).
 */
export const recordAnswer = operation({
  label: "loop.recordAnswer",
  input: z.object({
    id: z.string(),
    at: z.string().nullable(),
    named: z.boolean(),
    reason: z.string(),
  }),
  depends: { store, findingsLock, git },
  run: async ({ store: files, findingsLock: lock, git: answers }, { input }) => {
    const fixed = input.at ? answers.commitSha(input.at) : null;
    if (input.at && !fixed) return { refused: `${input.at} is not a commit` };

    const token = await lock.take();
    try {
      const rows = files.findings();
      const row = rows.find((f) => f.id === input.id);
      if (!row) return { refused: `no finding has id ${input.id}` };
      const refused = fixed ? answers.fixOrder(fixed, row, input.named) : null;
      if (refused) return { refused };

      const { sha: _sha, dirty: _dirty, ...kept } = row;
      const next = fixed
        ? { ...kept, status: "fixed", sha: fixed }
        : { ...kept, status: "answered", reason: input.reason };
      files.writeFindings(rows.map((f) => (f === row ? next : f)));
      return { fixed };
    } finally {
      lock.release(token);
    }
  },
});
