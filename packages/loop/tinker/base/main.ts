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
