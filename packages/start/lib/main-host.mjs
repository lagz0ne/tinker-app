/**
 * Host-owned command lifetime. Only the command receives exit; OS signals use stop.
 * First clean stop wins. A late thrown error is logged without changing that code.
 * A command that throws at startup exits 78 for a config error, else 1. Its closed may
 * resolve to root close results; the first failure among them exits 1.
 * @param {function} main - The app command.
 * @param {object} options - Host inputs (env, args, and cwd, which defaults to the process
 *   folder), start/stop hooks, and the hard-stop deadline.
 */
export function createMainHost(main, options) {
  const {
    env,
    args = [],
    cwd = process.cwd(),
    stdout,
    stderr,
    graceMs = 10_000,
    hardStop = () => process.kill(process.pid, "SIGKILL"),
    onStop,
  } = options;

  const controller = new AbortController();

  let code;

  let savedReason;

  const printed = new Set();
  const hostReasons = new WeakSet();

  const report = (prefix, reason, exitCode) => {
    if (reason == null || hostReasons.has(reason) || printed.has(reason)) return;
    printed.add(reason);
    const detail = describeReason(reason, exitCode);
    try {
      stderr.write(`${prefix}: ${detail}\n`);
    } catch {
      // A broken output stream must not block abort or the grace deadline.
    }
  };

  let timer;

  let finished = false;

  const stop = (next, reason) => {
    if (reason === undefined) {
      reason = new DOMException("Command stopped", "AbortError");
      hostReasons.add(reason);
    }
    if (code !== undefined || finished) {
      if (reason !== savedReason) report(`after exit ${code ?? 0}`, reason, next);

      return;
    }

    code = next;

    savedReason = reason;

    if (code !== 0) report(`command failed (exit ${code})`, savedReason, code);

    timer = setTimeout(() => hardStop(), graceMs);

    timer.unref?.();

    controller.abort(reason);
  };

  const started = Promise.resolve().then(() =>
    main({
      env,
      args,
      cwd,
      signal: controller.signal,
      stdout,
      stderr,
      exit: stop,
    }),
  );

  const closed = settleMain(started, options, controller.signal, stop).then(async (failed) => {
    try {
      await onStop?.();
    } catch (error) {
      failed = true;
      stderr.write(`host close failed: ${String(error)}\n`);
    }

    await flushOutput(stdout, stderr).catch(() => {
      failed = true;
    });
    finished = true;
    clearTimeout(timer);

    return code ?? (failed ? 1 : 0);
  });

  return {
    started,
    closed,
    signal: controller.signal,
    stop(next, reason) {
      // Only native host stops own these abort reasons; command exit does not.
      if (reason?.name === "AbortError") hostReasons.add(reason);
      stop(next, reason);
    },
  };
}

/** Error text is best effort; a bad payload must never interrupt a stop. */
function describeReason(reason, exitCode) {
  try {
    return exitCode !== 1 && reason.kind && reason.payload
      ? `${reason.kind}: ${JSON.stringify(reason.payload)}`
      : (reason.stack ?? String(reason));
  } catch {
    try {
      return reason.stack ?? String(reason);
    } catch {
      return "Unprintable command failure";
    }
  }
}

/** Native startup and close always join, including errors after exit. */
async function settleMain(started, options, signal, stop) {
  let app;
  try {
    app = await started;

    if (!app || !(app.closed instanceof Promise)) throw new TypeError("main must return closed");
    options.validate?.(app);

    if (!signal.aborted) await options.onStart?.(app, signal);

    const [failure] = closeFailures(await app.closed);

    if (failure === undefined) return false;
    stop(1, failure);

    return true;
  } catch (error) {
    return failedMain(error, app, signal, stop);
  }
}

/**
 * Root close results, in the order the command returned them: a failed root gives its error,
 * any other root its teardown errors. A closed with no results (an older command) gives none.
 * @param {unknown} ended - The value the command's closed resolved to.
 */
function closeFailures(ended) {
  return [ended ?? []]
    .flat()
    .flatMap((result) =>
      result.status === "failed" ? [result.error] : (result.teardownErrors ?? []),
    );
}

/**
 * Sysexits EX_CONFIG (78) for a startup error from config: a missing tag, a tag value that
 * failed its schema, or a bad URL. Any other error exits 1.
 * @param {unknown} error - Thrown by the command before it returned.
 */
function startupCode(error) {
  if (["MissingTag", "DataValidationFailed"].includes(error?.kind)) return 78;

  return error?.code === "ERR_INVALID_URL" ? 78 : 1;
}

/** Keep a late failure visible, and still join the app's cleanup when it has one. */
async function failedMain(error, app, signal, stop) {
  let failed = !signal.aborted || error !== signal.reason;

  if (failed) stop(app ? 1 : startupCode(error), error);
  if (!(app?.closed instanceof Promise)) return failed;

  await app.closed.catch((cleanup) => {
    if (cleanup !== error) {
      failed = true;
      stop(1, cleanup);
    }
  });

  return failed;
}

/**
 * Fence stdout, then stderr. Output whose reader is gone, a closed pipe or a closed terminal,
 * does not fail the command; any other write error does.
 */
async function flushOutput(stdout, stderr) {
  for (const stream of [stdout, stderr]) {
    await fenceStream(stream).catch((error) => {
      if (!readerGone(stream, error)) throw error;
    });
  }
}

/**
 * True when a write error means the stream's reader is gone: a closed pipe (EPIPE) on any
 * stream, or a closed terminal (EIO) on a terminal stream. On a file or a pipe, EIO is a real
 * write failure, such as a disk error, and the output is lost, so it still fails the run.
 * @param {{ isTTY?: boolean }} stream - From the host; why: EIO is quiet only on a terminal.
 * @param {unknown} error - From that stream; why: the code to judge.
 */
function readerGone(stream, error) {
  return error?.code === "EPIPE" || (error?.code === "EIO" && stream.isTTY === true);
}

/**
 * Keep a command running, and its exit code, when its output goes away: a reader such as
 * `head` closes the pipe (EPIPE), or a hangup closes the terminal (EIO on a terminal stream).
 * Any other error, EIO on a file included, still throws. Listens on each stream that can
 * listen. Returns the function that removes the listeners.
 * @param {...{ on?: Function, off?: Function }} streams - From a host; why: the output streams.
 */
export function quietGoneOutput(...streams) {
  const listeners = streams.map((stream) => [
    stream,
    (error) => {
      if (!readerGone(stream, error)) throw error;
    },
  ]);
  for (const [stream, listener] of listeners) stream.on?.("error", listener);
  return () => {
    for (const [stream, listener] of listeners) stream.off?.("error", listener);
  };
}

/** A callback after an empty write fences all prior writes on that stream. */
async function fenceStream(stream) {
  if (typeof stream.writable === "boolean" && !stream.destroyed) {
    await new Promise((resolve, reject) =>
      stream.write("", (error) => (error ? reject(error) : resolve())),
    );
  }
}

/** POSIX exit codes for a stop by signal: 128 plus the signal's number. */
const signalCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

/**
 * Run a process command with host-owned OS signals and flushed output. A closed terminal
 * (SIGHUP) stops it like Ctrl-C. Output that goes away, a closed pipe (EPIPE) or a closed
 * terminal (EIO on a terminal), on stdout or stderr, does not change the command's exit code.
 */
export async function runMain(main, options = {}) {
  const inputs = {
    env: process.env,
    args: process.argv.slice(2),
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
    ...options,
  };
  const host = createMainHost(main, inputs);

  const stops = Object.entries(signalCodes).map(([name, code]) => [
    name,
    () => host.stop(code, new DOMException(name, "AbortError")),
  ]);
  for (const [name, stop] of stops) process.on(name, stop);
  const loud = quietGoneOutput(inputs.stdout, inputs.stderr);
  try {
    process.exitCode = await host.closed;

    return process.exitCode;
  } finally {
    for (const [name, stop] of stops) process.off(name, stop);
    loud();
  }
}

/** Native dev registry crosses Vite's evaluated module and config loaders, keyed by app root. */
function devHosts() {
  const key = Symbol.for("@tinker/start.dev-hosts");

  return (globalThis[key] ??= new Map());
}

/** Vite owns the socket; its close must join the command before its CLI can finish. */
export function installDevServer(
  root,
  server,
  setExitCode = (code) => {
    process.exitCode = code;
  },
) {
  const entry = {};
  devHosts().set(root, entry);

  const nativeClose = server.close.bind(server);

  let closing;

  let requested = 0;

  const interrupt = () => {
    requested = 130;
    void server.close();
  };

  const terminate = () => {
    requested = 143;
    void server.close();
  };
  process.prependListener("SIGINT", interrupt);
  process.prependListener("SIGTERM", terminate);
  server.close = (...args) =>
    (closing ??= (async () => {
      entry.host?.stop(requested, new DOMException("Dev host stopped", "AbortError"));

      const code = entry.host ? await entry.host.closed : requested;
      try {
        await nativeClose(...args);
      } finally {
        setExitCode(code);
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", terminate);

        if (devHosts().get(root) === entry) devHosts().delete(root);
      }
    })());
  entry.close = server.close;
}

/** Register the evaluated command with the native Vite lifetime. */
export function registerDevMain(root, host) {
  const entry = devHosts().get(root);

  if (entry) entry.host = host;

  return () => {
    if (entry?.host === host) entry.host = undefined;
  };
}

/** A command exit also closes the dev socket and watchers, after the command is closed. */
export function finishDevMain(root, host) {
  const entry = devHosts().get(root);

  if (entry?.host === host) return entry.close();
}
