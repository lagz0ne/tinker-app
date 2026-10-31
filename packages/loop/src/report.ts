import { operation } from "@tinker/core";
import { z } from "zod";

import { finding } from "@/resources/store";

/**
 * The report lines more than one command prints, as operations so each call lands on a span and
 * names the value it shares (docs/decisions/loop-on-tinker.md).
 */

/** Severity order for lists and counts: what blocks done comes first. */
export const severities = ["important", "question", "nit", "old"];

/** Status order for lists and counts: open work comes first. */
export const statuses = ["open", "answered", "fixed"];

/** One finding on one line: its rule, where, what is wrong, and its id. */
export const findingLine = operation({
  label: "report.findingLine",
  input: finding,
  run: (_deps, { input }) => {
    const where = input.line ? `${input.file}:${input.line}` : input.file;
    return `${input.rule} ${where}: ${input.summary} [${input.id}]`;
  },
});

/** Counts by severity and by status, then each open important finding on one line. */
export const summary = operation({
  label: "report.summary",
  input: z.array(finding),
  depends: { findingLine },
  run: ({ findingLine: lineOf }, { input }) => {
    const bySeverity = severities.map((name) => {
      return `${name} ${input.filter((f) => f.severity === name).length}`;
    });
    const byStatus = statuses.map((name) => {
      return `${name} ${input.filter((f) => f.status === name).length}`;
    });
    const important = input.filter((f) => f.status === "open" && f.severity === "important");

    return [
      `severity: ${bySeverity.join(", ")}`,
      `status: ${byStatus.join(", ")}`,
      ...(important.length > 0
        ? ["open important:", ...important.map((f) => `  ${lineOf.run({ input: f })}`)]
        : []),
    ];
  },
});

/** A commit as its first 12 characters, or "no commit". */
export const shortSha = operation({
  label: "report.shortSha",
  input: z.string().nullable(),
  run: (_deps, { input }) => (input ? input.slice(0, 12) : "no commit"),
});

/** A count and its noun, plural unless it is one. */
export const count = operation({
  label: "report.count",
  input: z.object({ n: z.number(), noun: z.string() }),
  run: (_deps, { input }) => `${input.n} ${input.noun}${input.n === 1 ? "" : "s"}`,
});
