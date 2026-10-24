import { createScope, type Scope } from "@tinker/core";

import { checkClosed, defineMain } from "~/base/main";

import { readCommandLine, readLoopConfig } from "@/command-line";
import { handOff } from "@/old-tool";
import { answer } from "@/operations/answer";
import { check } from "@/operations/check";
import { findings } from "@/operations/findings";
import { review } from "@/operations/review";
import { rules } from "@/operations/rules";
import { status } from "@/operations/status";
import { appDir, baseRef, childEnv, print, stop, warn } from "@/tags";

/** What each operation's outcome means as an exit code; only this command picks them. */
const codes: Record<string, number> = {
  done: 0,
  red: 1,
  failed: 1,
  notDone: 1,
  needsPerson: 2,
  refused: 64,
};

/** How a stopped run exits, by the signal that stopped it. */
const stopCodes: Record<string, number> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

/** The commands that read loop.json. */
const configured = new Set(["check", "review"]);

/**
 * The ported commands: each settles its operation with this command line's input. A command
 * not here yet goes to the old tool in lib/.
 */
const ported = {
  check: (root: Scope.Handle) => root.settle(check),
  review: (root: Scope.Handle) => root.settle(review),
  answer: (root: Scope.Handle, line: CommandLine) =>
    root.settle(answer, {
      input: {
        id: line.positionals[0] ?? "",
        fixed: line.options.fixed ?? false,
        sha: line.options.sha,
        reason: line.options.reason,
      },
    }),
  status: (root: Scope.Handle) => root.settle(status),
  rules: (root: Scope.Handle, line: CommandLine) =>
    root.settle(rules, { input: { ids: line.positionals } }),
  findings: (root: Scope.Handle, line: CommandLine) =>
    root.settle(findings, {
      input: { open: line.options.open ?? false, rules: line.options.rules ?? false },
    }),
};

type CommandLine = Extract<ReturnType<typeof readCommandLine>, { ok: true }>;

/**
 * tinker-loop as a CLI-only Start app (docs/decisions/loop-on-tinker.md). This command is the
 * seam (ADR 0113): it alone reads the context, binds the tags, and picks the exit code. Ticket 8
 * ports the commands one by one; until a command is ported, it goes to the old tool in lib/.
 */
export default defineMain(async ({ env, args, cwd, stdout, stderr, signal, exit }) => {
  const finish = (code: number, problem?: string) => {
    if (problem) stderr.write(problem);
    exit(code);
    return { closed: Promise.resolve() };
  };
  /** The exit code for how the operation ended; a failure prints its message. */
  const codeOf = (ran: Awaited<ReturnType<(typeof ported)[keyof typeof ported]>>) => {
    if (ran.status === "failed") {
      const { error } = ran;
      stderr.write(`tinker-loop: ${error instanceof Error ? error.message : String(error)}\n`);
      return 78;
    }
    if (ran.status === "cancelled" || ran.value === "stopped") {
      return stopCodes[String(signal.reason)] ?? 130;
    }
    return codes[ran.value] ?? 1;
  };

  const line = readCommandLine(args, cwd);
  if (!line.ok) return finish(64, line.problem);
  if (!Object.hasOwn(ported, line.name)) {
    return finish(await handOff({ args: [...args], cwd, stdout, stderr, signal }));
  }
  const config = configured.has(line.name) ? readLoopConfig(line.app) : null;
  if (config && !config.ok) return finish(78, `tinker-loop: ${config.problem}\n`);

  const root = createScope({
    tags: [
      appDir(line.app),
      childEnv(env),
      baseRef(line.options.base ?? null),
      stop(signal),
      print((text) => stdout.write(`${text}\n`)),
      warn((text) => stderr.write(`${text}\n`)),
      ...(config ? [config.binding] : []),
    ],
    signal,
  });
  // A root with a stop signal settles its operations async, whatever settle's sync type says.
  const ran = await Promise.resolve(ported[line.name as keyof typeof ported](root, line));
  const code = codeOf(ran);
  const closed = root.close({ graceful: true }).then(checkClosed);
  exit(code);
  return { closed };
});
