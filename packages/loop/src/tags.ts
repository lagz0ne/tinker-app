import { tag } from "@tinker/core";

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

/** --base: the exact ref the scan starts from, or null to use loop.json's base. */
export const baseRef = tag<string | null>({ label: "loop.baseRef", default: null });

/** The tool's stop: the context's signal, so an operation stops early and writes nothing. */
export const stop = tag<AbortSignal>({ label: "loop.stop" });

/** The default reviewer's model, when loop.json names no review.command. */
export const reviewModel = tag<string>({ label: "loop.reviewModel", default: "claude-opus-5-5" });
