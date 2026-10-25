import { parseArgs } from "node:util";

import { resource, type RunResult } from "@tinker/core";
import { z } from "zod";

/** Each command's flags, and how many IDs it takes. */
const commands = {
  check: { flags: ["app", "base"], ids: "none" },
  findings: { flags: ["app", "open", "rules"], ids: "none" },
  rules: { flags: ["app"], ids: "any" },
  answer: { flags: ["app", "fixed", "sha", "reason"], ids: "one" },
  status: { flags: ["app"], ids: "none" },
  review: { flags: ["app", "base"], ids: "none" },
};

/** tinker-loop's flags: the ones that take a value are strings, the rest are on or off. */
const flags = {
  app: { type: "string" },
  base: { type: "string" },
  sha: { type: "string" },
  reason: { type: "string" },
  open: { type: "boolean" },
  rules: { type: "boolean" },
  fixed: { type: "boolean" },
} as const;

/** The command names, in usage order. */
export const commandName = z.enum(["check", "findings", "rules", "answer", "status", "review"]);

/**
 * The tool's command line, read by Node's parseArgs, and the word for how a command ended. Only
 * cmds/cli.ts uses it, and only the command picks the exit code from that word. A command file
 * imports no Node module, so the reading lives here.
 */
export const commandLine = resource({
  label: "loop.commandLine",
  factory: () => {
    const reader = {
      /** The app folder: --app against the folder the tool runs in, with `.` and `..` resolved. */
      folder: (cwd: string, given: string) => {
        const parts: string[] = [];
        for (const part of `${given.startsWith("/") ? "" : cwd}/${given}`.split("/")) {
          if (part === "..") parts.pop();
          else if (part && part !== ".") parts.push(part);
        }
        return `/${parts.join("/")}`;
      },

      /** Why the flags and IDs do not fit the command, or null; "" for no command at all. */
      problem: (command: string, given: string[], ids: string[]) => {
        const name = commandName.safeParse(command);
        if (!name.success) return "";

        const { flags: takes, ids: count } = commands[name.data];
        const extra = given.find((flag) => !takes.includes(flag));
        if (extra) return `tinker-loop ${command} does not take --${extra}\n`;
        if (count === "one" && ids.length !== 1) {
          return `tinker-loop ${command} takes one finding ID\n`;
        }
        return ids.length > 0 && count === "none" ? `tinker-loop ${command} takes no IDs\n` : null;
      },

      /** Why answer's flags do not fit together, or null: one of --fixed or --reason, with text. */
      answerProblem: (fixed: boolean, sha: string | undefined, reason: string | undefined) => {
        if (fixed === (reason !== undefined)) {
          return "tinker-loop answer: give --fixed or --reason, one of them\n";
        }
        if (sha !== undefined && !fixed) return "tinker-loop answer: --sha goes with --fixed\n";
        return reason !== undefined && !reason.trim()
          ? "tinker-loop answer: --reason needs text\n"
          : null;
      },

      /** Why the command line does not fit its command, answer's flags included, or null. */
      lineProblem: (
        command: string,
        values: { fixed?: boolean; sha?: string; reason?: string },
        ids: string[],
      ) => {
        const answerProblem =
          command === "answer"
            ? reader.answerProblem(values.fixed ?? false, values.sha, values.reason)
            : null;
        return reader.problem(command, Object.keys(values), ids) ?? answerProblem;
      },

      /**
       * The command line as one call: the command, its app folder and base, and its IDs and
       * flags; or the problem to print above the usage. `--flag value` and `--flag=value` both
       * work, and `--` ends the flags.
       */
      read: (args: readonly string[], cwd: string) => {
        const [command = "", ...rest] = args;
        let parsed;
        try {
          parsed = parseArgs({ args: rest, options: flags, allowPositionals: true, strict: true });
        } catch (error) {
          return { problem: `${(error as Error).message}\n` };
        }

        const { values, positionals: ids } = parsed;
        const name = commandName.safeParse(command);
        const problem = reader.lineProblem(command, values, ids);
        if (problem !== null || !name.success) return { problem: problem ?? "" };
        return {
          app: reader.folder(cwd, values.app ?? "."),
          base: values.base ?? null,
          call: reader.call(name.data, values, ids),
        };
      },

      /** The operation's input for a command: its IDs, and each flag on, off, or its text. */
      call: (
        command: z.infer<typeof commandName>,
        values: { open?: boolean; rules?: boolean; fixed?: boolean; sha?: string; reason?: string },
        ids: string[],
      ) => ({
        command,
        ids,
        open: values.open ?? false,
        rules: values.rules ?? false,
        fixed: values.fixed ?? false,
        sha: values.sha,
        reason: values.reason,
      }),

      /**
       * How a command ended, as one word: its outcome, "stopped", or "error" with the message to
       * print. A failure after a stop is a stop.
       */
      outcome: <T extends string>(ran: RunResult<T>, stopped: boolean) => {
        if (ran.status === "success" && ran.value !== "stopped") {
          return { word: ran.value, message: null };
        }
        if (ran.status !== "failed" || stopped) return { word: "stopped" as const, message: null };
        const { error } = ran;
        const message = `tinker-loop: ${error instanceof Error ? error.message : String(error)}`;
        return { word: "error" as const, message };
      },
    };

    return reader;
  },
});
