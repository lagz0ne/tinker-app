import { operation } from "@tinker/core";
import { z } from "zod";

import { findingLine, severities, statuses } from "@/report";
import { startRules } from "@/resources/start-rules";
import { store } from "@/resources/store";
import { print } from "@/tags";

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
    const texts = new Map(
      (book ?? []).map((rule) => [
        rule.id,
        rule.lines.map((line) => line.replace(/^- `[A-Z][0-9]+` /, "").trim()).join(" "),
      ]),
    );
    const all = files.findings();
    const shown = input.open ? all.filter((f) => f.status === "open") : all;

    const sorted = shown
      .map((f) => ({
        f,
        rank: statuses.indexOf(f.status ?? "") * 10 + severities.indexOf(f.severity ?? ""),
        rule: texts.get(f.rule ?? "") ?? "not in this Start's rules.md",
      }))
      .toSorted((a, b) => a.rank - b.rank);
    const lines = sorted.flatMap(({ f, rule }) => [
      `${f.status} ${f.severity} ${findingLine(f)} (round ${f.round})`,
      ...(book ? [`  rule: ${rule}`] : []),
      ...(f.status === "answered" ? [`  reason: ${f.reason}`] : []),
      ...(f.status === "fixed" && f.sha ? [`  fixed at ${f.sha.slice(0, 12)}`] : []),
      ...(f.status === "open" ? [`  fix: ${f.fix}`] : []),
    ]);
    for (const line of lines.length === 0 ? ["no findings"] : lines) say(line);
    return "done" as const;
  },
});
