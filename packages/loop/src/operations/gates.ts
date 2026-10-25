import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { operation } from "@tinker/core";

import { loopConfig } from "@/resources/loop-config";
import { processes } from "@/resources/processes";
import { store } from "@/resources/store";
import { print, stop } from "@/tags";

const ansi = new RegExp(String.raw`\u001b\[[0-9;?]*[A-Za-z]`, "g");

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
    const folder = join(files.folder(), "gates");
    mkdirSync(folder, { recursive: true });

    /** The first line that reads like an error, else the first line, else how it ended. */
    const firstErrorLine = (output: string, ending: string) => {
      const lines = output
        .replaceAll(ansi, "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const line =
        lines.find((text) => /error|fail|assert|not ok|✗|×/i.test(text)) ?? lines[0] ?? ending;
      return line.length > 200 ? `${line.slice(0, 197)}...` : line;
    };
    const one = async (gate: (typeof config.gates)[number]) => {
      const file = `${gate.name.replaceAll(/[^\w.-]/g, "-")}.log`;
      const log = join(".loop", "gates", file);
      const ending = await children.run(
        { command: gate.run, timeout: gate.timeout, out: join(folder, file) },
        signal,
      );
      say(`${ending ? "FAIL" : "PASS"} ${gate.name}`);
      if (!ending) return { name: gate.name, green: true };

      const summary = ending.startsWith("timed out")
        ? ending
        : firstErrorLine(readFileSync(join(folder, file), "utf8"), ending);
      const finding = {
        rule: "G1",
        severity: "important",
        file: gate.name,
        line: null,
        summary,
        trigger: `\`${gate.run}\` ${ending}; full output in ${log}`,
        fix: `Make \`${gate.run}\` pass.`,
        source: "check",
      };
      const id = files.findingId({ source: "check", rule: "G1", file: gate.name });
      return { name: gate.name, green: false, finding: { id, ...finding } };
    };

    const results: Awaited<ReturnType<typeof one>>[] = [];
    for (const gate of config.gates) {
      if (signal.aborted) break;
      results.push(await one(gate));
    }
    return results;
  },
});
