import type { z } from "zod";

import type { finding } from "@/resources/store";

/**
 * The report lines more than one command prints (docs/decisions/loop-on-tinker.md: the one plain
 * helper, since findings, status, check, and review share them).
 */

/** One finding on one line: its rule, where, what is wrong, and its id. */
export function findingLine(f: z.infer<typeof finding>) {
  const where = f.line ? `${f.file}:${f.line}` : f.file;
  return `${f.rule} ${where}: ${f.summary} [${f.id}]`;
}
