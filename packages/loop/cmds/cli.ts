import { createScope, type Scope } from "@tinker/core";

import { checkClosed, defineMain } from "~/base/main";

import { readCommandLine } from "@/command-line";
import { handOff } from "@/old-tool";
import { answer } from "@/operations/answer";
import { findings } from "@/operations/findings";
import { rules } from "@/operations/rules";
import { status } from "@/operations/status";
import { appDir, childEnv, print, warn } from "@/tags";

/** What each operation's outcome means as an exit code; only this command picks them. */
const codes: Record<string, number> = { done: 0, notDone: 1, needsPerson: 2, refused: 64 };

/**
 * The ported commands: each settles its operation with this command line's input. A command
 * not here yet goes to the old tool in lib/.
 */
const ported = {
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
  const line = readCommandLine(args, cwd);
  if (!line.ok) {
    stderr.write(line.problem);
    exit(64);
    return { closed: Promise.resolve() };
  }
  if (!Object.hasOwn(ported, line.name)) {
    exit(await handOff({ args: [...args], cwd, stdout, stderr, signal }));
    return { closed: Promise.resolve() };
  }

  const root = createScope({
    tags: [
      appDir(line.app),
      childEnv(env),
      print((text) => stdout.write(`${text}\n`)),
      warn((text) => stderr.write(`${text}\n`)),
    ],
    signal,
  });
  // A root with a stop signal settles its operations async, whatever settle's sync type says.
  const ran = await Promise.resolve(ported[line.name as keyof typeof ported](root, line));
  let code = ran.status === "success" ? (codes[ran.value] ?? 1) : 78;
  if (ran.status === "failed") {
    const { error } = ran;
    stderr.write(`tinker-loop: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  const closed = root.close({ graceful: true }).then(checkClosed);
  exit(code);
  return { closed };
});
