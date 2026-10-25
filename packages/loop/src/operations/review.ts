import { operation } from "@tinker/core";

import { summary } from "@/report";
import { git } from "@/resources/git";
import { outputRule, reviewer } from "@/resources/reviewer";
import { scan } from "@/resources/scan";
import { store } from "@/resources/store";
import { baseRef, print, stop, warn } from "@/tags";

import { recordReview } from "./record";

/**
 * `tinker-loop review [--base <ref>]`: a second model reviews the change, and its findings merge
 * as one review round. Findings are advice, so a review that ran is done; a reviewer that failed
 * or timed out writes nothing. The reviewer gets the app's tinker-review skill, or else its
 * Start's rules, the change as files (it runs no commands), and the open and answered review
 * findings to recheck.
 */
export const review = operation({
  label: "loop.review",
  depends: { baseRef, store, git, scan, reviewer, recordReview, print, warn, stop },
  run: async (deps) => {
    const { baseRef: wanted, store: files, git: answers, scan: scanner } = deps;
    const { reviewer: asker, recordReview: record, print: say, warn: complain } = deps;
    const signal = deps.stop;
    const rules = asker.rules();
    const range = scanner.range();
    if (!range) {
      complain(`tinker-loop review: git cannot find --base ${wanted}`);
      return "refused" as const;
    }

    // `.loop` ignores itself, so make it before the work tree is read.
    files.folder();
    const tree = answers.tree();
    const head = answers.headSha();
    const earlier = files.findings().filter((f) => f.source === "review" && f.rule !== outputRule);
    const open = earlier.filter((f) => f.status === "open");
    const answered = earlier.filter((f) => f.status === "answered");
    const patch = answers.run(
      [
        "-c",
        "core.quotePath=false",
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--relative",
        range.start,
      ],
      { raw: true },
    );
    asker.writeChange(patch, tree.untracked ?? []);
    if (rules.from) say(`review: no tinker-review skill in this app; using ${rules.from}`);
    say(`reviewed: ${answers.appScope()} only`);

    const view = { rules: rules.text, range, head, untracked: tree.untracked, open, answered };
    const ending = await asker.ask(asker.prompt(view), signal);
    if (signal.aborted) return "stopped" as const;
    if (ending) {
      complain(`tinker-loop review: the reviewer ${ending}; see .loop/review/stderr.log`);
      return "failed" as const;
    }

    const { reported, fixed } = asker.findings(open, answered);
    const round = { reported, fixed, sha: head, dirty: tree.dirty };
    const recorded = await record.run({ input: round });
    if (!recorded) return "stopped" as const;

    say(
      `tinker-loop review, round ${recorded.round}: ${reported.length} reported, ${fixed.length} rechecked fixed`,
    );
    for (const line of summary(recorded.merged)) say(line);
    return "done" as const;
  },
});
