import { operation } from "@tinker/core";
import { z } from "zod";

import { commandName } from "@/resources/command-line";

import { answer } from "./answer";
import { check } from "./check";
import { findings } from "./findings";
import { review } from "./review";
import { rules } from "./rules";
import { status } from "./status";

/** One tinker-loop command line, read by commandLine: it runs that command's operation. */
export const runCommand = operation({
  label: "loop.runCommand",
  input: z.object({
    command: commandName,
    ids: z.array(z.string()),
    open: z.boolean(),
    rules: z.boolean(),
    fixed: z.boolean(),
    sha: z.string().optional(),
    reason: z.string().optional(),
  }),
  depends: { check, review, status, rules, findings, answer },
  run: async (deps, { input }) => {
    switch (input.command) {
      case "check":
        return await deps.check.run();
      case "review":
        return await deps.review.run();
      case "status":
        return deps.status.run();
      case "rules":
        return deps.rules.run({ input: { ids: input.ids } });
      case "findings":
        return deps.findings.run({ input: { open: input.open, rules: input.rules } });
      default: {
        const { ids, fixed, sha, reason } = input;
        return await deps.answer.run({ input: { id: ids[0] ?? "", fixed, sha, reason } });
      }
    }
  },
});
