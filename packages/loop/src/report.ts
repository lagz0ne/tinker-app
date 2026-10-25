import type { z } from "zod";

import type { finding } from "@/resources/store";

/**
 * The report lines more than one command prints (docs/decisions/loop-on-tinker.md: the plain
 * helpers the port allows, since findings, status, check, and review share them).
 */

/** Severity order for lists and counts: what blocks done comes first. */
export const severities = ["important", "question", "nit", "old"];

/** Status order for lists and counts: open work comes first. */
export const statuses = ["open", "answered", "fixed"];

/**
 * One finding on one line: its rule, where, what is wrong, and its id.
 * @param f - From the findings file; why: the row to show.
 */
export function findingLine(f: z.infer<typeof finding>) {
  const where = f.line ? `${f.file}:${f.line}` : f.file;
  return `${f.rule} ${where}: ${f.summary} [${f.id}]`;
}

/**
 * Counts by severity and by status, then each open important finding on one line.
 * @param findings - From a merge of the findings file; why: the rows to count.
 */
export function summary(findings: z.infer<typeof finding>[]) {
  const bySeverity = severities.map((name) => {
    return `${name} ${findings.filter((f) => f.severity === name).length}`;
  });
  const byStatus = statuses.map((name) => {
    return `${name} ${findings.filter((f) => f.status === name).length}`;
  });
  const important = findings.filter((f) => f.status === "open" && f.severity === "important");

  return [
    `severity: ${bySeverity.join(", ")}`,
    `status: ${byStatus.join(", ")}`,
    ...(important.length > 0
      ? ["open important:", ...important.map((f) => `  ${findingLine(f)}`)]
      : []),
  ];
}

/**
 * A commit as its first 12 characters, or "no commit".
 * @param sha - From git or the last check; why: the commit to show.
 */
export function shortSha(sha: string | null) {
  return sha ? sha.slice(0, 12) : "no commit";
}

/**
 * A count and its noun, plural unless it is one.
 * @param n - From a count of rows; why: the number to show.
 * @param noun - From the caller's text; why: what is counted.
 */
export function count(n: number, noun: string) {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
