/**
 * Host-owned command lifetime. Only the command receives exit; OS signals use stop.
 * First clean stop wins. A late thrown error is logged without changing that code.
 * @param {function} main - The app command.
 * @param {object} options - Host inputs, start/stop hooks, and the hard-stop deadline.
 */
export function createMainHost(main, options) {
  const {
    env,
    args = [],
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

  const report = (prefix, reason) => {
    if (reason == null || reason.name === "AbortError" || printed.has(reason)) return;
    printed.add(reason);
    stderr.write(`${prefix}: ${reason.stack ?? String(reason)}\n`);
  };

  let timer;

  let finished = false;

  const stop = (next, reason = new DOMException("Command stopped", "AbortError")) => {
    if (code !== undefined || finished) {
      if (reason !== savedReason) report(`after exit ${code ?? 0}`, reason);

      return;
    }

    code = next;

    savedReason = reason;

    timer = setTimeout(() => hardStop(), graceMs);

    timer.unref?.();

    controller.abort(reason);
  };

  const started = Promise.resolve().then(() =>
    main({
      env,
      args,
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

    if (code !== undefined && code !== 0) report(`command failed (exit ${code})`, savedReason);

    await flushOutput([stdout, stderr]).catch(() => {
      failed = true;
    });
    finished = true;
    clearTimeout(timer);

    return code ?? (failed ? 1 : 0);
  });

  return { started, closed, stop, signal: controller.signal };
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

/** A callback after an empty write fences all prior writes on that stream. */
async function flushOutput(streams) {
  for (const stream of streams) {
    if (typeof stream.writable === "boolean" && !stream.destroyed) {
      await new Promise((resolve, reject) =>
        stream.write("", (error) => (error ? reject(error) : resolve())),
      );
    }
  }
}

/** Run a process command with host-owned OS signals and flushed output. */
export async function runMain(main, options = {}) {
  const host = createMainHost(main, {
    env: process.env,
    args: process.argv.slice(2),
    stdout: process.stdout,
    stderr: process.stderr,
    ...options,
  });

  const interrupt = () => host.stop(130, new DOMException("SIGINT", "AbortError"));

  const terminate = () => host.stop(143, new DOMException("SIGTERM", "AbortError"));

  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    process.exitCode = await host.closed;

    return process.exitCode;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
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
