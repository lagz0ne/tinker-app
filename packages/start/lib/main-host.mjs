/**
 * Host-owned command lifetime. Only the command receives exit; OS signals use stop.
 * First clean stop wins. A late thrown error is logged without changing that code.
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

    await app.closed;

    return false;
  } catch (error) {
    return failedMain(error, app, signal, stop);
  }
}

/** Keep a late failure visible, and still join the app's cleanup. */
async function failedMain(error, app, signal, stop) {
  let failed = !signal.aborted || error !== signal.reason;

  if (failed) stop(1, error);

  await app?.closed.catch((cleanup) => {
    if (cleanup !== error) {
      failed = true;
      stop(1, cleanup);
    }
  });

  return failed;
}

/**
 * Fence stdout, then stderr. A reader that closed stdout early, such as `head`, is gone:
 * its EPIPE does not fail the command. EPIPE on stderr is not special.
 */
async function flushOutput(stdout, stderr) {
  await fenceStream(stdout).catch((error) => {
    if (error?.code !== "EPIPE") throw error;
  });
  await fenceStream(stderr);
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
 * (SIGHUP) stops it like Ctrl-C. A reader that closes stdout early (EPIPE) does not change
 * the command's exit code.
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
  const quietEpipe = (error) => {
    if (error?.code !== "EPIPE") throw error;
  };

  for (const [name, stop] of stops) process.on(name, stop);
  inputs.stdout.on?.("error", quietEpipe);
  try {
    process.exitCode = await host.closed;

    return process.exitCode;
  } finally {
    for (const [name, stop] of stops) process.off(name, stop);
    inputs.stdout.off?.("error", quietEpipe);
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
