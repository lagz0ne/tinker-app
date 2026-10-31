import { createScope } from "@tinker/core";

import { defineMain } from "~/base/main";
import { renderObservation } from "~/base/observe";
import { observeServerPanics } from "~/base/panics.server";
import { createServerHandler, stoppedFetch } from "~/base/server-entry";
import { abortReasons } from "~/components/errors";
import { startRequests, backendStop } from "~/components/requests";
import {
  telemetryExport,
  telemetrySide,
  telemetryService,
  tracesUrl,
  logsUrl,
  logLevel,
  spanHistory,
  consoleOutput,
  observer,
  renderObserve,
  renderNs,
  browserIngest,
  browserTelemetry,
  telemetryWorker,
  threadExport,
  threadObserver,
  threadRenderObserve,
  threadIngest,
} from "~/components/telemetry/index.server";

/** The host starts the server; importing this command opens nothing. */
// oxlint-disable-next-line complexity -- Commands keep env bindings inline. Tests cover input, startup, exit, and close.
export default defineMain(async ({ env, args, signal, stdout, stderr, exit }) => {
  if (args.length) {
    stderr.write("Usage: tinker serve\n");
    exit(64);
    return { fetch: stoppedFetch, closed: Promise.resolve() };
  }
  const stop = { tools: new AbortController(), app: new AbortController() };
  const appStop = AbortSignal.any([signal, stop.app.signal]);
  /** A built server sends telemetry from a worker thread; dev and tests keep it on this thread. */
  const threaded = !import.meta.env.DEV;
  const tools = createScope({
    signal: stop.tools.signal,
    extensions: [threaded ? threadExport : telemetryExport],
    tags: [
      threaded && telemetryWorker(new URL("./telemetry-worker.js", import.meta.url)),
      telemetrySide("server"),
      consoleOutput(stdout),
      env.OTEL_SERVICE_NAME !== undefined && telemetryService(env.OTEL_SERVICE_NAME),
      env.VICTORIA_TRACES_URL !== undefined && tracesUrl(new URL(env.VICTORIA_TRACES_URL)),
      env.VICTORIA_LOGS_URL !== undefined && logsUrl(new URL(env.VICTORIA_LOGS_URL)),
      env.LOG_LEVEL !== undefined && logLevel(Number(env.LOG_LEVEL)),
      env.SPAN_HISTORY !== undefined && spanHistory(Number(env.SPAN_HISTORY)),
    ],
  });

  await tools.ready;

  try {
    const app = createScope({
      signal: appStop,
      observe: tools.resolve(threaded ? threadObserver : observer),
      extensions: [startRequests],
      tags: [
        backendStop(appStop),
        renderObservation(
          threaded
            ? tools.resolve(threadRenderObserve, { ns: renderNs })
            : tools.resolve(renderObserve, { ns: renderNs }),
        ),
        browserTelemetry(tools.resolve(threaded ? threadIngest : browserIngest).ingest),
      ],
    });

    // The host fails the run with the first failure in these results, app first.
    const closed = app.closed.then(async function closeRoots(appEnd) {
      stop.tools.abort(abortReasons.closed);
      return [appEnd, await tools.closed];
    });

    try {
      await app.ready;
      signal.throwIfAborted(); // Aborted during start: app is closing, so no handler.
    } catch (error) {
      // The app's own close failure; tools close is read below.
      const appEnd = (await closed)[0];
      const cleanup = appEnd.status === "failed" ? appEnd.error : appEnd.teardownErrors?.[0];
      if (cleanup !== undefined && cleanup !== error) {
        stderr.write(`close failed: ${String(cleanup)}\n`);
      }
      throw error;
    }
    app.onClose(observeServerPanics(exit.bind(null, 1), closed, stderr));
    return {
      fetch: createServerHandler(
        { requestContext: app.resolve(startRequests) },
        { dev: import.meta.env.DEV },
      ).fetch,
      closed,
    };
  } catch (error) {
    stop.tools.abort(error);
    const toolsEnd = await tools.closed;
    const cleanup = toolsEnd.status === "failed" ? toolsEnd.error : toolsEnd.teardownErrors?.[0];
    if (cleanup !== undefined && cleanup !== error) {
      stderr.write(`close failed: ${String(cleanup)}\n`);
    }
    throw error;
  }
});
