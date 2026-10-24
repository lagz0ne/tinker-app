import { tag } from "@tinker/core";
import { z } from "zod";

/**
 * The tool's inputs. Only cmds/cli.ts binds them, from ctx.cwd, --app, and ctx.env (the seam rule,
 * ADR 0113); no resource and no default reads env or process.
 */

/** The app folder: --app, else the folder the tool runs in. */
export const appDir = tag<string>({ label: "loop.appDir" });

/** The env for child processes: gates, the reviewer, and git. Bound from ctx.env. */
export const childEnv = tag<Readonly<Record<string, string | undefined>>>({
  label: "loop.childEnv",
});

/** Write one line to the tool's stdout. Output is an outside effect, so cmds/cli.ts binds it. */
export const print = tag<(line: string) => void>({ label: "loop.print" });

/** Write one line to the tool's stderr. Bound by cmds/cli.ts, like print. */
export const warn = tag<(line: string) => void>({ label: "loop.warn" });

/** The default reviewer's model, when loop.json names no review.command. */
export const reviewModel = tag<string>({ label: "loop.reviewModel", default: "claude-opus-5-5" });

/** The longest timer Node can set; a longer one fires at once. */
const maxTimeoutMs = 2_147_483_647;

/** loop.json once its checks pass: the shape the rest of the tool reads. */
const checked = z.object({
  gates: z.array(z.object({ name: z.string(), run: z.string(), timeout: z.number().optional() })),
  base: z.string().nullable(),
  review: z.object({ command: z.array(z.string()).optional(), timeout: z.number().optional() }),
});

/**
 * loop.json, checked: its gates, its base branch, and its optional review block. A refusal names
 * the first problem, in the words the tool printed before the port.
 */
export const loopConfig = tag({
  label: "loop.config",
  parse: z
    .unknown()
    .transform((raw, ctx) => {
      const config = (raw ?? {}) as { gates?: unknown; base?: unknown; review?: unknown };
      const problem = gatesProblem(config.gates) ?? reviewProblem(config.review);
      if (problem) {
        ctx.addIssue({ code: "custom", message: problem });
        return z.NEVER;
      }

      return {
        gates: config.gates,
        base: typeof config.base === "string" ? config.base : null,
        review: config.review ?? {},
      };
    })
    .pipe(checked),
});

/** @param timeout - From loop.json; why: Node timers take whole ms up to 2^31 - 1. */
function timeoutProblem(timeout: unknown) {
  if (timeout === undefined) return null;
  if (!Number.isSafeInteger(timeout) || (timeout as number) <= 0) {
    return "must be a positive whole number of milliseconds";
  }
  return (timeout as number) > maxTimeoutMs
    ? `must be at most ${maxTimeoutMs} ms, about 24 days`
    : null;
}

/** @param gates - From loop.json; why: each gate needs a name, a run, and its own log file. */
function gatesProblem(gates: unknown) {
  if (!Array.isArray(gates) || gates.length === 0) return '"gates" must list at least one gate';
  const bad = gates.map(gateProblem).find(Boolean);
  if (bad) return bad;

  if (new Set(gates.map((gate) => gate.name)).size !== gates.length) {
    return "gate names must differ";
  }
  const logs = new Set(gates.map((gate) => `${gate.name.replaceAll(/[^\w.-]/g, "-")}.log`));
  return logs.size === gates.length
    ? null
    : "gate names must differ after each character other than a letter, digit, '.', '_', or '-' becomes '-', since each names a log file";
}

/** @param gate - From gatesProblem; why: one gate to check. */
function gateProblem(gate: { name?: unknown; run?: unknown; timeout?: unknown } | null) {
  if (typeof gate?.name !== "string" || !gate.name || typeof gate.run !== "string") {
    return 'each gate needs a "name" and a "run" string';
  }

  const problem = timeoutProblem(gate.timeout);
  return problem ? `gate ${gate.name}: "timeout" ${problem}` : null;
}

/** @param review - From loop.json; why: the reviewer's argv and timeout, when given. */
function reviewProblem(review: unknown) {
  if (review === undefined) return null;
  if (!review || typeof review !== "object" || Array.isArray(review)) {
    return '"review" must be an object';
  }

  const { command, timeout } = review as { command?: unknown; timeout?: unknown };
  if (command !== undefined && !argv(command)) {
    return '"review.command" must list the program and its arguments as strings';
  }
  const problem = timeoutProblem(timeout);
  return problem ? `"review.timeout" ${problem}` : null;
}

/** @param command - From loop.json; why: an argv is words, the program first. */
function argv(command: unknown) {
  return (
    Array.isArray(command) &&
    command.length > 0 &&
    command.every((word) => typeof word === "string" && word !== "")
  );
}
