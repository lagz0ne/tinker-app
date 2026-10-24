import { operation } from "@tinker/core";
import { z } from "zod";

import { startRules } from "@/resources/start-rules";
import { print, warn } from "@/tags";

/**
 * `tinker-loop rules [ID...]`: the rules of the app's own Start. With IDs, only those, in the
 * asked order, once each, in any case; with none, every rule under its group heading. An unknown
 * ID is refused with the known IDs.
 */
export const rules = operation({
  label: "loop.rules",
  input: z.object({ ids: z.array(z.string()) }),
  depends: { startRules, print, warn },
  run: ({ startRules: found, print: say, warn: refuse }, { input }) => {
    const book = found.read();
    const wanted = [...new Set(input.ids.map((id) => id.toUpperCase()))];
    const unknown = wanted.filter((id) => !book.rules.some((rule) => rule.id === id));
    if (unknown.length > 0) {
      const known = book.rules.map((rule) => rule.id).join(", ");
      refuse(`tinker-loop: unknown rule ${unknown.join(", ")}; known rules: ${known}`);
      return "refused" as const;
    }

    say(`@tinker/start ${book.version}: ${book.path}`);
    const lines =
      wanted.length > 0
        ? wanted.flatMap((id) => ["", ...(book.rules.find((rule) => rule.id === id)?.lines ?? [])])
        : book.rules.flatMap((rule, index) => [
            ...(rule.group !== book.rules[index - 1]?.group ? ["", `### ${rule.group}`, ""] : []),
            ...rule.lines,
          ]);
    for (const line of lines) say(line);
    return "done" as const;
  },
});
