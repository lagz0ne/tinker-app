import type { MainClosed, MainContext } from "./main";

type Output = MainContext["stdout"] & {
  writable?: boolean;
  destroyed?: boolean;
  isTTY?: boolean;
  write(chunk: string, done?: (error?: Error | null) => void): unknown;
  on?(event: "error", listener: (error: unknown) => void): unknown;
  off?(event: "error", listener: (error: unknown) => void): unknown;
};

type Main<R> = (ctx: MainContext) => Promise<R>;

export declare namespace MainHost {
  type Options = {
    env: MainContext["env"];
    args?: readonly string[];
    /** The folder the command runs in; the process folder when left out. */
    cwd?: string;
    stdout: Output;
    stderr: Output;
    /** How long a stopped command may take to close before the hard stop. */
    graceMs?: number;
    hardStop?: () => void;
    /** Runs once the command returned, unless it already stopped. */
    onStart?: (app: { closed: MainClosed }, signal: AbortSignal) => unknown;
  };
}

/** POSIX exit codes for a stop by signal: 128 plus the signal's number. */
const signalCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;

/**
 * The command host, for a command with no port: a one-shot command such as `cmds/import.ts`, and
 * the tests that run a command in process. Only the command receives `exit`; a host stop aborts
 * its signal. The first stop's code wins. A startup throw exits 78 for a config error (a missing
 * tag or config key, a value that failed its schema, or a bad URL), else 1; a failed root exits 1.
 * A failure prints one line: `command failed (exit <code>): <kind>: <payload>`, or the error's
 * stack.
 */
export function createMainHost<R extends { closed: MainClosed }>(
  main: Main<R>,
  options: MainHost.Options,
) {
  const { env, args = [], cwd = process.cwd(), stdout, stderr, graceMs = 10_000 } = options;
  const hardStop = options.hardStop ?? (() => process.kill(process.pid, "SIGKILL"));
  const controller = new AbortController();
  const printed = new Set<unknown>();
  const hostReasons = new WeakSet<object>();
  let code: number | undefined;
  let savedReason: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;

  // The first stop starts the grace timer: a command still open when it ends gets the hard stop.
  controller.signal.addEventListener("abort", () => {
    timer = setTimeout(hardStop, graceMs);
    timer.unref?.();
  });

  const stop = (next: number, reason?: unknown) => {
    if (reason === undefined) {
      const own = new DOMException("Command stopped", "AbortError");
      hostReasons.add(own);
      reason = own;
    }

    // The first stop sets the code and prints a failing reason; a later one prints a new reason
    // as late. Each reason prints once, and a host stop's own reason never.
    const late = code !== undefined || finished;
    if (late && reason === savedReason) return;
    const prefix = late ? `after exit ${code ?? 0}` : `command failed (exit ${next})`;
    [reason]
      .filter(
        (given) =>
          (late || next !== 0) &&
          given != null &&
          !printed.has(given) &&
          !hostReasons.has(Object(given)),
      )
      .forEach((given) => {
        printed.add(given);
        const value = Object(given);
        const { kind, payload, stack } = value;

        // Error text is best effort; a bad payload must never interrupt a stop. The stack (or
        // the reason's text) is the fallback when the payload cannot print.
        let detail = "Unprintable command failure";
        try {
          detail = stack ?? String(value);
        } catch {
          // The fixed line stays.
        }
        try {
          if (next !== 1 && kind && payload) detail = `${kind}: ${JSON.stringify(payload)}`;
        } catch {
          // The fallback stays.
        }
        try {
          stderr.write(`${prefix}: ${detail}\n`);
        } catch {
          // A broken output stream must not block abort or the grace deadline.
        }
      });
    if (late) return;

    code = next;
    savedReason = reason;
    controller.abort(reason);
  };

  const started = Promise.resolve().then(() =>
    main({ env, args, cwd, signal: controller.signal, stdout, stderr, exit: stop }),
  );

  const settled = started.then(
    async (app) => {
      // The first failure in the root close results, app first: a failed root's error, else
      // that root's first teardown error.
      const ended = Promise.resolve().then(async () => {
        if (!(app?.closed instanceof Promise)) throw new TypeError("main must return closed");
        if (!controller.signal.aborted) await options.onStart?.(app, controller.signal);
        return [(await app.closed) ?? []].flat();
      });

      return ended.then(
        (results) => {
          const failure = results
            .flatMap((end) => (end.status === "failed" ? [end.error] : (end.teardownErrors ?? [])))
            .at(0);
          if (failure === undefined) return false;
          stop(1, failure);
          return true;
        },
        async (error: unknown) => {
          // A stop's own reason is no failure; a close error that is not this error prints late.
          let failed = !controller.signal.aborted || error !== controller.signal.reason;
          if (failed) stop(1, error);
          if (!(app?.closed instanceof Promise)) return failed;
          await app.closed.catch((cleanup: unknown) => {
            if (cleanup === error) return;
            failed = true;
            stop(1, cleanup);
          });
          return failed;
        },
      );
    },
    (error: unknown) => {
      // A startup throw: 78 for a config error, else 1. A stop's own reason is no failure.
      const failed = !controller.signal.aborted || error !== controller.signal.reason;
      const config = ["MissingTag", "MissingConfig", "DataValidationFailed"].includes(
        Object(error).kind,
      );
      if (failed) stop(config || Object(error).code === "ERR_INVALID_URL" ? 78 : 1, error);
      return failed;
    },
  );

  const closed = settled.then(async (failed) => {
    for (const stream of [stdout, stderr]) {
      // A callback after an empty write fences all prior writes on that stream.
      const fence = new Promise<void>((resolve, reject) => {
        if (typeof stream.writable !== "boolean" || stream.destroyed) return resolve();
        stream.write("", (error) => (error ? reject(error) : resolve()));
      });
      await fence.catch((error: unknown) => {
        // A gone reader is no failure: a closed pipe (EPIPE), or a closed terminal (EIO on a
        // terminal). On a file or a pipe, EIO is a real write failure.
        const { code: why } = Object(error);
        if (why !== "EPIPE" && !(why === "EIO" && stream.isTTY === true)) failed = true;
      });
    }
    finished = true;
    clearTimeout(timer);
    return code ?? (failed ? 1 : 0);
  });

  return {
    started,
    closed,
    signal: controller.signal,
    stop(next: number, reason?: unknown) {
      // Only native host stops own these abort reasons; a command's exit does not.
      if (reason instanceof DOMException && reason.name === "AbortError") hostReasons.add(reason);
      stop(next, reason);
    },
  };
}

/**
 * Run a command as a process: OS signals stop it (a closed terminal, SIGHUP, like Ctrl-C), and
 * its code becomes the process exit code. Output whose reader is gone does not change that code.
 */
export async function runMain<R extends { closed: MainClosed }>(
  main: Main<R>,
  options: Partial<MainHost.Options> = {},
) {
  const inputs: MainHost.Options = {
    env: process.env,
    args: process.argv.slice(2),
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
    ...options,
  };

  const host = createMainHost(main, inputs);
  const stops = Object.entries(signalCodes).map(
    ([name, exitCode]) =>
      [name, () => host.stop(exitCode, new DOMException(name, "AbortError"))] as const,
  );
  for (const [name, handler] of stops) process.on(name, handler);
  const quiet = (error: unknown) => {
    const { code } = Object(error);
    if (code !== "EPIPE" && !(code === "EIO" && inputs.stdout.isTTY === true)) throw error;
  };
  inputs.stdout.on?.("error", quiet);
  inputs.stderr.on?.("error", quiet);
  try {
    process.exitCode = await host.closed;
    return process.exitCode;
  } finally {
    for (const [name, handler] of stops) process.off(name, handler);
    inputs.stdout.off?.("error", quiet);
    inputs.stderr.off?.("error", quiet);
  }
}
