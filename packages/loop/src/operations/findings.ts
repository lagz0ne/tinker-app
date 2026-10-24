import { operation } from "@tinker/core";
import { z } from "zod";

import { startRules } from "@/resources/start-rules";
import { store } from "@/resources/store";
import { print } from "@/tags";

/** Severity order for lists: what blocks done comes first. */
const severities = ["important", "question", "nit", "old"];

/** Status order for lists: open work comes first. */
const statuses = ["open", "answered", "fixed"];

/**
 * `tinker-loop findings [--open] [--rules]`: the findings as a list, open first, then
 * answered, then fixed, important first in each. With --rules, each shows its rule's text.
 */
export const findings = operation({
  label: "loop.findings",
  input: z.object({ open: z.boolean(), rules: z.boolean() }),
  depends: { store, startRules, print },
  run: ({ store: files, startRules: found, print: say }, { input }) => {
    const book = input.rules ? found.read().rules : null;
    const all = files.findings();
    const shown = input.open ? all.filter((f) => f.status === "open") : all;

    const rank = (f: (typeof all)[number]) =>
      statuses.indexOf(f.status ?? "") * 10 + severities.indexOf(f.severity ?? "");
    const ruleText = (id: string | undefined) => {
      const rule = book?.find((entry) => entry.id === id);
      if (!rule) return "not in this Start's rules.md";
      return rule.lines.map((line) => line.replace(/^- `[A-Z][0-9]+` /, "").trim()).join(" ");
    };
    const linesOf = (f: (typeof all)[number]) => {
      const where = f.line ? `${f.file}:${f.line}` : f.file;
      return [
        `${f.status} ${f.severity} ${f.rule} ${where}: ${f.summary} [${f.id}] (round ${f.round})`,
        ...(book ? [`  rule: ${ruleText(f.rule)}`] : []),
        ...(f.status === "answered" ? [`  reason: ${f.reason}`] : []),
        ...(f.status === "fixed" && f.sha ? [`  fixed at ${f.sha.slice(0, 12)}`] : []),
        ...(f.status === "open" ? [`  fix: ${f.fix}`] : []),
      ];
    };

    const sorted = shown.toSorted((a, b) => rank(a) - rank(b));
    const lines = sorted.length === 0 ? ["no findings"] : sorted.flatMap(linesOf);
    for (const line of lines) say(line);
    return "done" as const;
  },
});
