import { createScope } from "@tinker/core";

import { defineMain } from "~/base/main";

import { runCommand } from "@/operations/run-command";
import { commandLine } from "@/resources/command-line";
import { appDir, baseRef, childEnv, print, stop, warn } from "@/tags";

const usage = [
  "usage: tinker-loop check [--app <dir>] [--base <ref>]",
  "       tinker-loop findings [--app <dir>] [--open] [--rules]",
  "       tinker-loop rules [ID...] [--app <dir>]",
  '       tinker-loop answer <ID> (--fixed [--sha <sha>] | --reason "<text>") [--app <dir>]',
  "       tinker-loop status [--app <dir>]",
  "       tinker-loop review [--app <dir>] [--base <ref>]",
].join("\n");

/** What each way a command ends means as an exit code; only this command picks them. */
const codes = {
  done: 0,
  red: 1,
  failed: 1,
  notDone: 1,
  needsPerson: 2,
  refused: 64,
  error: 78,
} as const;

/** How a stopped run exits, by the signal that stopped it. */
const stopCodes: Partial<Record<string, number>> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

/**
 * tinker-loop as a CLI-only Start app (docs/decisions/loop-on-tinker.md). This command is the
 * seam (ADR 0113): it alone reads the context, binds the tags, and picks the exit code. The
 * command line is read first, in a root of its own, since the app root needs its folder; then
 * the command is one operation on the app's resources. Both roots close before `closed`.
 */
export default defineMain(async ({ env, args, cwd, stdout, stderr, signal, exit }) => {
  const reading = createScope({});
  const lineReader = reading.resolve(commandLine);
  const line = lineReader.read(args, cwd);
  const roots = [reading];
  let code: number = 64;

  if ("problem" in line) stderr.write(`${line.problem}${usage}\n`);
  else {
    const root = createScope({
      tags: [
        appDir(line.app),
        childEnv(env),
        baseRef(line.base),
        stop(signal),
        print((text) => stdout.write(`${text}\n`)),
        warn((text) => stderr.write(`${text}\n`)),
      ],
      signal,
    });
    roots.push(root);
    // A root with a stop signal settles its operations async, whatever settle's sync type says.
    const ran = await Promise.resolve(root.settle(runCommand, { input: line.call }));
    const { word, message } = lineReader.outcome(ran, signal.aborted);
    if (message) stderr.write(`${message}\n`);

    // runMain stops with a DOMException named by its signal.
    const reason: unknown = signal.reason;
    const name = reason instanceof Error ? reason.message : String(reason);
    code = word === "stopped" ? (stopCodes[name] ?? 130) : codes[word];
  }

  // Work and cleanup errors surface before exit: a failed close rejects `closed`.
  const closed = Promise.all(roots.map((root) => root.close({ graceful: true }))).then(
    (results) => {
      for (const result of results) {
        if (result.status === "failed") throw result.error;
        if (result.teardownErrors?.length) throw result.teardownErrors[0];
      }
    },
  );
  exit(code);
  return { closed };
});
