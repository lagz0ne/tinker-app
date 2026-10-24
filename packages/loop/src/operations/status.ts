import { operation } from "@tinker/core";

import { findingLine } from "@/report";
import { git } from "@/resources/git";
import { store } from "@/resources/store";
import { print } from "@/tags";

/** A person checks the work when review findings are still open after this many reviews. */
const reviewRoundsForPerson = 3;

/**
 * `tinker-loop status`: the stop rule. Done: the last check ran at HEAD on the same work tree as
 * now, every gate was green, and no important finding is open. Needs a person: not done, an
 * important review finding is open, and 3 or more review rounds are recorded. Else not done.
 * Each open important finding gets one line, then the verdict.
 */
export const status = operation({
  label: "loop.status",
  depends: { store, git, print },
  run: ({ store: files, git: answers, print: say }) => {
    const short = (sha: string | null) => (sha ? sha.slice(0, 12) : "no commit");
    const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

    const findings = files.findings();
    const last = files.lastCheck();
    const head = answers.headSha();
    const tree = last && last.sha === head ? answers.tree().fingerprint : null;
    const open = findings.filter((f) => f.status === "open" && f.severity === "important");
    const reviewOpen = open.filter((f) => f.source === "review");
    const rounds = new Set(
      files
        .rounds()
        .filter((r) => r.source === "review")
        .map((r) => r.round),
    );

    /** Why the last check does not count as green for the work tree as it is now. */
    const checkReasons = () => {
      if (!last) return ["no check has run; run tinker-loop check"];
      const red = last.gates.filter((gate) => !gate.green).map((gate) => gate.name);
      return [
        ...(last.sha !== head
          ? [
              `the last check ran at ${short(last.sha)}, but HEAD is ${short(head)}; run tinker-loop check`,
            ]
          : []),
        ...(last.sha === head && last.tree !== tree
          ? ["the tree changed since the last check; run tinker-loop check"]
          : []),
        ...(red.length > 0
          ? [`${count(red.length, "gate")} red in the last check: ${red.join(", ")}`]
          : []),
      ];
    };

    const reasons = [
      ...checkReasons(),
      ...(open.length > 0 ? [`${count(open.length, "important finding")} open`] : []),
    ];
    for (const f of open) say(`open important ${findingLine(f)}`);
    if (reasons.length === 0) {
      say(`done: all gates green at ${short(head)}, no important finding open`);
      return "done" as const;
    }

    if (reviewOpen.length > 0 && rounds.size >= reviewRoundsForPerson) {
      say(
        `needs a person: ${count(rounds.size, "review round")}, and ${count(reviewOpen.length, "important review finding")} still open`,
      );
      return "needsPerson" as const;
    }
    say(`not done: ${reasons.join("; ")}`);
    return "notDone" as const;
  },
});
