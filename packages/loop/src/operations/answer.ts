import { operation } from "@tinker/core";
import { z } from "zod";

import { print, warn } from "@/tags";

import { recordAnswer } from "./record";

/**
 * `tinker-loop answer <ID> (--fixed [--sha <sha>] | --reason "<text>")`: mark one finding fixed
 * at a commit, or answered with a reason, under the findings lock. The row stays in the file.
 * The fix commit must be in HEAD's history and come after `seenSha`, the HEAD when a tool last
 * saw the finding; a row with no `seenSha` takes only a fix named with --sha. The command line
 * already checked that the flags fit together.
 */
export const answer = operation({
  label: "loop.answer",
  input: z.object({
    id: z.string(),
    fixed: z.boolean(),
    sha: z.string().optional(),
    reason: z.string().optional(),
  }),
  depends: { recordAnswer, print, warn },
  run: async ({ recordAnswer: record, print: say, warn: complain }, { input }) => {
    const at = input.fixed ? (input.sha ?? "HEAD") : null;
    const reason = (input.reason ?? "").trim();
    // The command line checks the flags; a direct caller still needs a fix or a reason.
    if (at === null && !reason) {
      complain("tinker-loop answer: --reason needs text");
      return "refused" as const;
    }

    const call = { id: input.id, at, named: input.sha !== undefined, reason };
    const done = await record.run({ input: call });
    if ("refused" in done) {
      complain(`tinker-loop answer: ${done.refused}`);
      return "refused" as const;
    }

    const { fixed } = done;
    say(fixed ? `fixed ${input.id} at ${fixed.slice(0, 12)}` : `answered ${input.id}: ${reason}`);
    return "done" as const;
  },
});
