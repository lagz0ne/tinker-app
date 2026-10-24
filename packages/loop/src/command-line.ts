import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { loopConfig } from "@/tags";

/**
 * The tool's inputs, read (docs/decisions/loop-on-tinker.md): the command line's Data parse,
 * and the app's loop.json. cmds/cli.ts reads the context and calls these; a command file imports
 * no Node module, so they live here.
 */

const usage = [
  "usage: tinker-loop check [--app <dir>] [--base <ref>]",
  "       tinker-loop findings [--app <dir>] [--open] [--rules]",
  "       tinker-loop rules [ID...] [--app <dir>]",
  '       tinker-loop answer <ID> (--fixed [--sha <sha>] | --reason "<text>") [--app <dir>]',
  "       tinker-loop status [--app <dir>]",
  "       tinker-loop review [--app <dir>] [--base <ref>]",
].join("\n");

/** Each command's flags, and how many IDs it takes. */
const commands = {
  check: { flags: ["app", "base"], ids: "none" },
  findings: { flags: ["app", "open", "rules"], ids: "none" },
  rules: { flags: ["app"], ids: "any" },
  answer: { flags: ["app", "fixed", "sha", "reason"], ids: "one" },
  status: { flags: ["app"], ids: "none" },
  review: { flags: ["app", "base"], ids: "none" },
};

/**
 * The tool's command line, read: the command, the app folder (--app against cwd), the flags,
 * and the IDs; or why it does not fit, with the usage after it.
 */
export function readCommandLine(args: readonly string[], cwd: string) {
  const [command = "", ...rest] = args;
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        app: { type: "string", default: "." },
        base: { type: "string" },
        open: { type: "boolean" },
        rules: { type: "boolean" },
        fixed: { type: "boolean" },
        sha: { type: "string" },
        reason: { type: "string" },
      },
    });
  } catch (error) {
    return { ok: false as const, problem: `${(error as Error).message}\n${usage}\n` };
  }

  const { values: options, positionals } = parsed;
  if (!Object.hasOwn(commands, command)) return { ok: false as const, problem: `${usage}\n` };
  const name = command as keyof typeof commands;
  const { flags, ids } = commands[name];
  const extra = Object.keys(options).find((flag) => !flags.includes(flag));
  if (extra) {
    return {
      ok: false as const,
      problem: `tinker-loop ${name} does not take --${extra}\n${usage}\n`,
    };
  }
  const wrongIds = {
    one: positionals.length !== 1 ? "takes one finding ID" : null,
    none: positionals.length > 0 ? "takes no IDs" : null,
    any: null,
  }[ids];
  if (wrongIds) {
    return { ok: false as const, problem: `tinker-loop ${name} ${wrongIds}\n${usage}\n` };
  }
  return { ok: true as const, name, app: resolve(cwd, options.app), options, positionals };
}

/**
 * The app's loop.json as a loopConfig binding, or why it cannot be read: missing, not JSON, or
 * refused by the tag's schema, in the words the tool printed before the port.
 */
export function readLoopConfig(app: string) {
  const path = join(app, "loop.json");
  if (!existsSync(path)) return { ok: false as const, problem: `${path} is missing` };

  /** Core refuses a bad binding with DataValidationFailed; its cause holds the schema issues. */
  const refusal = (error: unknown) => {
    const refused = error as {
      payload?: { cause?: { payload?: { issues?: { message: string }[] } } };
    };
    return refused.payload?.cause?.payload?.issues?.[0]?.message ?? String(error);
  };
  const bind = (raw: unknown) => {
    try {
      return { ok: true as const, binding: loopConfig(raw as never) };
    } catch (error) {
      return { ok: false as const, problem: `${path}: ${refusal(error)}` };
    }
  };

  try {
    return bind(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    return { ok: false as const, problem: (error as Error).message };
  }
}
