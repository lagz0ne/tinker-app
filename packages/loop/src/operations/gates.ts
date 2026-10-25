import { operation } from "@tinker/core";
import type { z } from "zod";

import { loopConfig } from "@/resources/loop-config";
import { processes } from "@/resources/processes";
import { type finding, store } from "@/resources/store";
import { print, stop } from "@/tags";

/**
 * Run every gate of loop.json in order, all of them, even after a red one; stop early only on
 * the stop. Each gate's stdout and stderr go to one log, `.loop/gates/<name>.log`, and each gate
 * prints one PASS or FAIL line. A red gate is one important G1 finding.
 */
export const gates = operation({
  label: "loop.gates",
  depends: { loopConfig, processes, store, print, stop },
  run: async ({
    loopConfig: config,
    processes: children,
    store: files,
    print: say,
    stop: signal,
  }) => {
    const results: { name: string; green: boolean; finding?: z.infer<typeof finding> }[] = [];
    for (const gate of config.gates) {
      if (signal.aborted) break;
      const log = files.gateLog(gate.name);
      const job = { command: gate.run, timeout: gate.timeout, out: log.path };
      const ending = await children.run(job, signal);
      say(`${ending ? "FAIL" : "PASS"} ${gate.name}`);
      if (!ending) {
        results.push({ name: gate.name, green: true });
        continue;
      }

      const summary = ending.startsWith("timed out") ? ending : files.gateError(gate.name, ending);
      const row = {
        rule: "G1",
        severity: "important",
        file: gate.name,
        line: null,
        summary,
        trigger: `\`${gate.run}\` ${ending}; full output in ${log.shown}`,
        fix: `Make \`${gate.run}\` pass.`,
        source: "check",
      };
      const id = files.findingId({ source: "check", rule: "G1", file: gate.name });
      results.push({ name: gate.name, green: false, finding: { id, ...row } });
    }
    return results;
  },
});
