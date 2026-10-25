import type { Scope } from "@tinker/core";

/** The host supplies inputs and owns process stop. Commands choose exit codes. */
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

/** Type-only entry marker, with no startup, state, or hidden error policy. */
export const defineMain = <R extends { closed: Promise<void> }>(
  main: (ctx: MainContext) => Promise<R>,
) => main;

/** @param error - From command startup; why: map only known config errors to 78. */
export function mainErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return 1;
  if ("kind" in error && ["MissingTag", "DataValidationFailed"].includes(String(error.kind))) {
    return 78;
  }
  if ("code" in error && error.code === "ERR_INVALID_URL") return 78;
  return 1;
}

/** @param result - From a closed root; why: surface work and cleanup errors before exit. */
export function checkClosed(result: Scope.Result) {
  if (result.status === "failed") throw result.error;
  if (result.teardownErrors?.length) throw result.teardownErrors[0];
}
