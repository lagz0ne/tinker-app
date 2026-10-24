import { operation } from "@tinker/core";
import { z } from "zod";

import { git } from "@/resources/git";
import { store } from "@/resources/store";
import { print, warn } from "@/tags";

/**
 * `tinker-loop answer <ID> (--fixed [--sha <sha>] | --reason "<text>")`: mark one finding fixed
 * at a commit, or answered with a reason, under the findings lock. The row stays in the file.
 * The fix commit must be in HEAD's history and come after `seenSha`, the HEAD when a tool last
 * saw the finding; a row with no `seenSha` takes only a fix named with --sha.
 */
export const answer = operation({
  label: "loop.answer",
  input: z.object({
    id: z.string(),
    fixed: z.boolean(),
    sha: z.string().optional(),
    reason: z.string().optional(),
  }),
  depends: { store, git, print, warn },
  run: async ({ store: files, git: answers, print: say, warn: complain }, { input }) => {
    const short = (sha: string) => sha.slice(0, 12);
    const refuse = (why: string) => {
      complain(`tinker-loop answer: ${why}`);
      return "refused" as const;
    };
    const lineProblem = () => {
      if (input.fixed === (input.reason !== undefined)) {
        return "give --fixed or --reason, one of them";
      }
      if (input.sha !== undefined && !input.fixed) return "--sha goes with --fixed";
      return input.reason !== undefined && !input.reason.trim() ? "--reason needs text" : null;
    };
    const seenProblem = (id: string, seen: string, fixed: string, head: string) => {
      if (!answers.inHistory(seen, head)) {
        return `finding ${id} was seen at ${short(seen)}, which is no longer in HEAD's history (amended or rebased); run tinker-loop check, or the tool that saw it, again`;
      }
      if (fixed === seen || !answers.inHistory(seen, fixed)) {
        return `finding ${id} was seen at ${short(seen)}; commit the fix after it, then answer`;
      }
      return null;
    };
    const fixProblem = (id: string, seen: string | undefined, fixed: string) => {
      const head = answers.headSha() ?? "HEAD";
      if (!answers.inHistory(fixed, head)) return `commit ${short(fixed)} is not in HEAD's history`;
      if (seen) return seenProblem(id, seen, fixed, head);
      return input.sha !== undefined
        ? null
        : `finding ${id} has no seenSha, so no tool recorded where it was seen; name the fix commit with --sha`;
    };

    const fixed = input.fixed ? answers.commitSha(input.sha ?? "HEAD") : null;
    const reason = () => input.reason?.trim() ?? "";
    const problem = () => {
      const line = lineProblem();
      if (line) return line;
      return input.fixed && !fixed ? `${input.sha ?? "HEAD"} is not a commit` : null;
    };
    const change = () => {
      const rows = files.findings();
      const row = rows.find((f) => f.id === input.id);
      if (!row) return `no finding has id ${input.id}`;
      const refused = fixed ? fixProblem(row.id, row.seenSha, fixed) : null;
      if (refused) return refused;

      const { sha: _sha, dirty: _dirty, ...kept } = row;
      const next = fixed
        ? { ...kept, status: "fixed", sha: fixed }
        : { ...kept, status: "answered", reason: reason() };
      files.writeFindings(rows.map((f) => (f === row ? next : f)));
      return null;
    };

    const early = problem();
    if (early) return refuse(early);
    const refused = await files.locked(change);
    if (refused) return refuse(refused);

    say(fixed ? `fixed ${input.id} at ${short(fixed)}` : `answered ${input.id}: ${reason()}`);
    return "done" as const;
  },
});
