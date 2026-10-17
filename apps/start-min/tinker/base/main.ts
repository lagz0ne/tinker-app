import type { Scope } from "@tinker/core";

/** The host supplies inputs and owns process stop. Commands choose exit codes. */
export type MainContext = {
  env: Readonly<Record<string, string | undefined>>;
  args: readonly string[];
  signal: AbortSignal;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  exit: (code: number, reason?: unknown) => void;
};

/** Type-only entry marker, with no startup, state, or hidden error policy. */
export const defineMain = <R extends { closed: Promise<void> }>(
  main: (ctx: MainContext) => Promise<R>,
) => main;

/** @param result - From a closed root; why: surface work and cleanup errors before exit. */
export function checkClosed(result: Scope.Result) {
  if (result.status === "failed") throw result.error;
  if (result.teardownErrors?.length) throw result.teardownErrors[0];
}
