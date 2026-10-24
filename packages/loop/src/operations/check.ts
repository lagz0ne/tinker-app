import { operation } from "@tinker/core";

import { summary } from "@/report";
import { git } from "@/resources/git";
import { scan } from "@/resources/scan";
import { store } from "@/resources/store";
import { baseRef, print, stop } from "@/tags";

import { gates } from "./gates";

/**
 * `tinker-loop check [--base <ref>]`: run every gate, scan the change, merge into the findings
 * file under the lock, save what this run saw, and print the summary. A stop during the gates
 * or the scan writes nothing. A finding seen again keeps its id and an answer's reason, and a
 * fixed one opens again; a check finding that is gone becomes fixed when this run checked it;
 * scan rows change only when the scan ran; judge and review findings stay.
 */
export const check = operation({
  label: "loop.check",
  depends: { baseRef, store, git, scan, gates, print, stop },
  run: async (deps) => {
    const { baseRef: wanted, store: files, git: answers, scan: scanner } = deps;
    const { gates: runGates, print: say, stop: signal } = deps;
    files.folder();
    const before = answers.tree();
    const results = await runGates.run();
    if (signal.aborted) return "stopped" as const;

    const red = results.flatMap((gate) => (gate.finding ? [gate.finding] : []));
    const ref = scanner.base();
    const diff = ref ? scanner.diff(ref, before.untracked) : null;
    /** The scan's hits, after a line that says where it started or why it was skipped. */
    const scanHits = () => {
      if (diff !== null) {
        say(`scan base: ${ref}`);
        return scanner.hits(diff);
      }
      const why = ref ? `git cannot diff from ${ref}` : "no base found; pass --base <ref>";
      say(`scan skipped: ${wanted && !ref ? `git cannot find --base ${wanted}` : why}`);
      say("earlier scan findings stay as they are");
      return [];
    };
    const hits = scanHits();
    const run = { sha: answers.headSha(), scanned: diff !== null, dirty: before.dirty };
    const after = answers.tree().fingerprint;
    if (signal.aborted) return "stopped" as const;

    let round = 0;
    const merge = () => {
      // A stop can land while another tool holds the lock; then this run writes nothing.
      if (signal.aborted) return null;
      const previous = files.findings();
      round = files.nextRound();
      const stamp = { ...run, round };

      const found = new Map([...red, ...hits].map((finding) => [finding.id, finding]));
      const merged = previous.map((old) => {
        const now = found.get(old.id);
        found.delete(old.id);
        if (now) return files.seen(old, now, stamp);

        const checked = old.source === "check" && (old.rule === "G1" || run.scanned);
        return !checked || old.status === "fixed" ? old : files.fixed(old, stamp);
      });
      const next = [
        ...merged,
        ...[...found.values()].map((finding) => files.opened(finding, stamp)),
      ];
      files.writeFindings(next);
      return next;
    };
    // A stop while another tool holds the lock ends the wait: then this run is stopped.
    const merged = await files.locked(merge, signal).catch((error: unknown) => {
      if (signal.aborted) return null;
      throw error;
    });
    if (!merged) return "stopped" as const;

    const gateResults = results.map(({ name, green }) => ({ name, green }));
    files.writeLastCheck({ round, sha: run.sha, tree: after, gates: gateResults });
    say(`checked: ${answers.appScope()} only`);
    say(
      `tinker-loop check, round ${round}: ${results.length - red.length} gates green, ${red.length} red`,
    );
    for (const line of summary(merged)) say(line);
    return red.length > 0 ? ("red" as const) : ("done" as const);
  },
});
