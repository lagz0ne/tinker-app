import { createScope, type Scope } from "@tinker/core";

import { renderObservation } from "~/base/observe";
import { observeServerPanics } from "~/base/panics.server";
import { createServerHandler } from "~/base/server-entry";
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
} from "~/components/telemetry/index.server";

/** The host starts the server; importing this command opens nothing. */
// oxlint-disable-next-line complexity -- Commands keep env bindings inline. Tests cover input, startup, exit, and close.
export default async function main({
  env,
  signal,
  stdout,
  stderr,
}: {
  env: Readonly<Record<string, string | undefined>>;
  signal: AbortSignal;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
}) {
  const stop = { tools: new AbortController(), app: new AbortController() };
  const appStop = AbortSignal.any([signal, stop.app.signal]);
  const tools = createScope({
    signal: stop.tools.signal,
    extensions: [telemetryExport],
    tags: [
      telemetrySide("server"),
      consoleOutput(stdout),
      env.OTEL_SERVICE_NAME !== undefined && telemetryService(env.OTEL_SERVICE_NAME),
      env.VICTORIA_TRACES_URL !== undefined && tracesUrl(new URL(env.VICTORIA_TRACES_URL)),
      env.VICTORIA_LOGS_URL !== undefined && logsUrl(new URL(env.VICTORIA_LOGS_URL)),
      env.LOG_LEVEL !== undefined && logLevel(Number(env.LOG_LEVEL)),
      env.SPAN_HISTORY !== undefined && spanHistory(Number(env.SPAN_HISTORY)),
    ],
  });

  /** @param result - From a root's closed promise; why: report its first failure after cleanup. */
  function ended(result: Scope.Result) {
    if (result.status === "failed") throw result.error;
    if (result.teardownErrors?.length) throw result.teardownErrors[0];
  }

  await tools.ready;

  try {
    const app = createScope({
      signal: appStop,
      observe: tools.resolve(observer),
      extensions: [startRequests],
      tags: [
        backendStop(appStop),
        renderObservation(tools.resolve(renderObserve, { ns: renderNs })),
        browserTelemetry(tools.resolve(browserIngest).ingest),
      ],
    });

    const closed = app.closed.then(async function closeRoots(appEnd) {
      stop.tools.abort(abortReasons.closed);
      const toolsEnd = await tools.closed;
      ended(appEnd);
      ended(toolsEnd);
    });
    void closed.catch(() => {});

    try {
      await app.ready;
      signal.throwIfAborted(); // Aborted during start: app is closing, so no handler.
    } catch (error) {
      await closed.catch((cleanup) => {
        if (cleanup !== error) stderr.write(`close failed: ${String(cleanup)}\n`);
      });
      throw error;
    }
    app.onClose(observeServerPanics(stop.app.abort.bind(stop.app), closed, stderr));
    return {
      fetch: createServerHandler(
        { requestContext: app.resolve(startRequests) },
        { dev: import.meta.env.DEV },
      ).fetch,
      closed,
    };
  } catch (error) {
    stop.tools.abort(error);
    try {
      ended(await tools.closed);
    } catch (cleanup) {
      if (cleanup !== error) stderr.write(`close failed: ${String(cleanup)}\n`);
    }
    throw error;
  }
}
