import type { z } from "zod";

import type { finding } from "@/resources/store";

/**
 * The report lines more than one command prints (docs/decisions/loop-on-tinker.md: the one plain
 * helper the port allows, since findings, status, check, and review share them).
 */

/** Severity order for lists and counts: what blocks done comes first. */
export const severities = ["important", "question", "nit", "old"];

/** Status order for lists and counts: open work comes first. */
export const statuses = ["open", "answered", "fixed"];

/** One finding on one line: its rule, where, what is wrong, and its id. */
export function findingLine(f: z.infer<typeof finding>) {
  const where = f.line ? `${f.file}:${f.line}` : f.file;
  return `${f.rule} ${where}: ${f.summary} [${f.id}]`;
}

/** Counts by severity and by status, then each open important finding on one line. */
export function summary(findings: z.infer<typeof finding>[]) {
  const count = (field: "severity" | "status", names: string[]) =>
    names.map((name) => `${name} ${findings.filter((f) => f[field] === name).length}`).join(", ");
  const important = findings.filter((f) => f.status === "open" && f.severity === "important");

  return [
    `severity: ${count("severity", severities)}`,
    `status: ${count("status", statuses)}`,
    ...(important.length > 0
      ? ["open important:", ...important.map((f) => `  ${findingLine(f)}`)]
      : []),
  ];
}
