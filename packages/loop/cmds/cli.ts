import { createScope } from "@tinker/core";

import { checkClosed, defineMain } from "~/base/main";

import { answer } from "@/operations/answer";
import { check } from "@/operations/check";
import { findings } from "@/operations/findings";
import { review } from "@/operations/review";
import { rules } from "@/operations/rules";
import { status } from "@/operations/status";
import { appDir, baseRef, childEnv, print, stop, warn } from "@/tags";

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

/** The flags that take a value; the rest are on or off. */
const valued = ["app", "base", "sha", "reason"];
const switched = ["open", "rules", "fixed"];

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

/**
 * tinker-loop as a CLI-only Start app (docs/decisions/loop-on-tinker.md). This command is the
 * seam (ADR 0113): it alone reads the context and the command line, binds the tags, and picks
 * the exit code; each command is one operation on the app's resources. A command file imports
 * no Node module, so the command line is read here by hand.
 */
export default defineMain(async ({ env, args, cwd, stdout, stderr, signal, exit }) => {
  const [command = "", ...rest] = args;
  const values = new Map<string, string>();
  const switches = new Set<string>();
  const ids: string[] = [];

  /** A flag that takes a value: `--flag value` or `--flag=value`. Returns the next index. */
  const readValued = (flag: string, inline: string | undefined, index: number) => {
    const value = inline ?? rest[index + 1];
    if (value === undefined) throw new Error(`Option '--${flag} <value>' argument missing`);
    values.set(flag, value);
    return inline === undefined ? index + 2 : index + 1;
  };
  /** A flag word: `--flag`, `--flag=value`, or `--flag value`. Returns the next index. */
  const readFlag = (word: string, index: number) => {
    const equals = word.indexOf("=");
    const flag = word.slice(2, equals < 0 ? undefined : equals);
    const inline = equals < 0 ? undefined : word.slice(equals + 1);

    if (word.startsWith("--") && valued.includes(flag)) return readValued(flag, inline, index);
    if (!word.startsWith("--") || !switched.includes(flag)) {
      throw new Error(`Unknown option '${word}'`);
    }
    if (inline !== undefined) throw new Error(`Option '--${flag}' does not take an argument`);
    switches.add(flag);
    return index + 1;
  };
  /** One word of the command line: `--`, a flag, or an ID. Returns the next index. */
  const readWord = (index: number) => {
    const word = rest[index] ?? "";
    if (word === "--") return ids.push(...rest.slice(index + 1)) && rest.length;
    if (!word.startsWith("-")) return ids.push(word) && index + 1;
    return readFlag(word, index);
  };
  /** Why the command line does not fit its command, or null. */
  const lineProblem = () => {
    if (!Object.hasOwn(commands, command)) return "";

    const { flags, ids: takes } = commands[command as keyof typeof commands];
    const extra = [...values.keys(), ...switches].find((flag) => !flags.includes(flag));
    if (extra) return `tinker-loop ${command} does not take --${extra}\n`;
    if (takes === "one" && ids.length !== 1) return `tinker-loop ${command} takes one finding ID\n`;
    return ids.length > 0 && takes === "none" ? `tinker-loop ${command} takes no IDs\n` : null;
  };
  /** The app folder: --app against the folder the tool runs in, with `.` and `..` resolved. */
  const appFolder = () => {
    const given = values.get("app") ?? ".";
    const parts: string[] = [];
    for (const part of `${given.startsWith("/") ? "" : cwd}/${given}`.split("/")) {
      if (part === "..") parts.pop();
      else if (part && part !== ".") parts.push(part);
    }
    return `/${parts.join("/")}`;
  };
  /** The exit code a stop gives; runMain stops with a DOMException named by its signal. */
  const stopCode = () => {
    const reason: unknown = signal.reason;
    return stopCodes[reason instanceof Error ? reason.message : String(reason)] ?? 130;
  };

  try {
    for (let index = 0; index < rest.length;) index = readWord(index);
  } catch (error) {
    stderr.write(`${(error as Error).message}\n${usage}\n`);
    exit(64);
    return { closed: Promise.resolve() };
  }
  const problem = lineProblem();
  if (problem !== null) {
    stderr.write(`${problem}${usage}\n`);
    exit(64);
    return { closed: Promise.resolve() };
  }

  const root = createScope({
    tags: [
      appDir(appFolder()),
      childEnv(env),
      baseRef(values.get("base") ?? null),
      stop(signal),
      print((text) => stdout.write(`${text}\n`)),
      warn((text) => stderr.write(`${text}\n`)),
    ],
    signal,
  });
  const operations = {
    check: () => root.settle(check),
    review: () => root.settle(review),
    status: () => root.settle(status),
    rules: () => root.settle(rules, { input: { ids } }),
    findings: () =>
      root.settle(findings, {
        input: { open: switches.has("open"), rules: switches.has("rules") },
      }),
    answer: () =>
      root.settle(answer, {
        input: {
          id: ids[0] ?? "",
          fixed: switches.has("fixed"),
          sha: values.get("sha"),
          reason: values.get("reason"),
        },
      }),
  };
  /** The exit code for how the operation ended; a failure that is not a stop prints its message. */
  const codeOf = (ran: Awaited<ReturnType<(typeof operations)[keyof typeof operations]>>) => {
    if (ran.status === "success" && ran.value !== "stopped") return codes[ran.value] ?? 1;
    if (ran.status !== "failed" || signal.aborted) return stopCode();
    const { error } = ran;
    stderr.write(`tinker-loop: ${error instanceof Error ? error.message : String(error)}\n`);
    return 78;
  };

  // A root with a stop signal settles its operations async, whatever settle's sync type says.
  const ran = await Promise.resolve(operations[command as keyof typeof operations]());
  const code = codeOf(ran);
  const closed = root.close({ graceful: true }).then(checkClosed);
  exit(code);
  return { closed };
});
