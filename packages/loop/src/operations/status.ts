import { operation } from "@tinker/core";

import { count, findingLine, shortSha } from "@/report";
import { git } from "@/resources/git";
import { store } from "@/resources/store";
import { print } from "@/tags";

/** A person checks the work when review findings are still open after this many reviews. */
const reviewRoundsForPerson = 3;

/** Why the last check does not count as green for the work tree as it is now; none when it does. */
export const checkReasons = operation({
  label: "loop.checkReasons",
  depends: { store, git },
  run: ({ store: files, git: answers }) => {
    const last = files.lastCheck();
    if (!last) return ["no check has run; run tinker-loop check"];

    const head = answers.headSha();
    const tree = last.sha === head ? answers.tree().fingerprint : null;
    const red = last.gates.filter((gate) => !gate.green).map((gate) => gate.name);
    return [
      ...(last.sha !== head
        ? [
            `the last check ran at ${shortSha(last.sha)}, but HEAD is ${shortSha(head)}; run tinker-loop check`,
          ]
        : []),
      ...(last.sha === head && last.tree !== tree
        ? ["the tree changed since the last check; run tinker-loop check"]
        : []),
      ...(red.length > 0
        ? [`${count(red.length, "gate")} red in the last check: ${red.join(", ")}`]
        : []),
    ];
  },
});

/**
 * `tinker-loop status`: the stop rule. Done: the last check ran at HEAD on the same work tree as
 * now, every gate was green, and no important finding is open. Needs a person: not done, an
 * important review finding is open, and 3 or more review rounds are recorded. Else not done.
 * Each open important finding gets one line, then the verdict.
 */
export const status = operation({
  label: "loop.status",
  depends: { store, git, checkReasons, print },
  run: ({ store: files, git: answers, checkReasons: checks, print: say }) => {
    const findings = files.findings();
    const open = findings.filter((f) => f.status === "open" && f.severity === "important");
    const reviewOpen = open.filter((f) => f.source === "review");
    const rounds = new Set(
      files
        .rounds()
        .filter((r) => r.source === "review")
        .map((r) => r.round),
    );
    const reasons = [
      ...checks.run(),
      ...(open.length > 0 ? [`${count(open.length, "important finding")} open`] : []),
    ];

    for (const f of open) say(`open important ${findingLine(f)}`);
    if (reasons.length === 0) {
      say(`done: all gates green at ${shortSha(answers.headSha())}, no important finding open`);
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
