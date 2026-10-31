import { operation } from "@tinker/core";

import { summary } from "@/report";
import { git } from "@/resources/git";
import { scan } from "@/resources/scan";
import { store } from "@/resources/store";
import { print, stop } from "@/tags";

import { gates } from "./gates";
import { recordCheck } from "./record";

/**
 * `tinker-loop check [--base <ref>]`: run every gate, scan the change, merge into the findings
 * file under the lock, save what this run saw, and print the summary. A stop during the gates
 * or the scan writes nothing. recordCheck says how findings merge.
 */
export const check = operation({
  label: "loop.check",
  depends: { store, git, scan, gates, recordCheck, summary, print, stop },
  run: async (deps) => {
    const { store: files, git: answers, scan: scanner, gates: runGates } = deps;
    const { recordCheck: record, summary: summarize, print: say, stop: signal } = deps;
    files.folder();
    const before = answers.tree();
    const results = await runGates.run();
    if (signal.aborted) return "stopped" as const;

    const red = results.flatMap((gate) => (gate.finding ? [gate.finding] : []));
    const scanned = scanner.check(before.untracked);
    for (const note of scanned.notes) say(note);
    const sha = answers.headSha();
    const after = answers.tree().fingerprint;
    if (signal.aborted) return "stopped" as const;

    const found = [...red, ...scanned.hits];
    const run = { sha, scanned: scanned.scanned, dirty: before.dirty };
    const recorded = await record.run({ input: { found, ...run } });
    if (!recorded) return "stopped" as const;

    const gateResults = results.map(({ name, green }) => ({ name, green }));
    files.writeLastCheck({ round: recorded.round, sha, tree: after, gates: gateResults });
    say(`checked: ${answers.appScope()} only`);
    say(
      `tinker-loop check, round ${recorded.round}: ${results.length - red.length} gates green, ${red.length} red`,
    );
    for (const line of summarize.run({ input: recorded.merged })) say(line);
    return red.length > 0 ? ("red" as const) : ("done" as const);
  },
});
