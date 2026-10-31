import type { Scope } from "@tinker/core";

/**
 * The host supplies inputs and owns process stop. A command picks its own exit codes. A startup
 * throw exits 78 for a config error, else 1; the host maps it, so a command just lets it throw.
 */
export type MainContext = {
  env: Readonly<Record<string, string | undefined>>;
  args: readonly string[];
  /** The folder the process runs in; the host reads it, so commands read no process global. */
  cwd: string;
  signal: AbortSignal;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  exit: (code: number, reason?: unknown) => void;
};

/**
 * What `closed` gives the host: the root close results, app first, then tools. Root by root, the
 * host exits 1 with a failed root's error, else that root's first teardown error.
 */
export type MainClosed = Promise<void | Scope.Result | readonly Scope.Result[]>;

/** Type-only entry marker, with no startup, state, or hidden error policy. */
export const defineMain = <R extends { closed: MainClosed }>(
  main: (ctx: MainContext) => Promise<R>,
) => main;
