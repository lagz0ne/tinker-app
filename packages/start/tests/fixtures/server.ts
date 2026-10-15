import { createScope } from "@tinker/core";

import { once } from "~/base/close";
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
// oxlint-disable-next-line complexity -- Cmd seam keeps Duke's inline env !== undefined && tag(...) list in plain view; deliberately untested glue.
async function main() {
  // Vite dev already loaded .env; this covers npm start.
  try {
    process.loadEnvFile();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }

  const stop = { tools: new AbortController(), app: new AbortController() };

  const tools = createScope({
    signal: stop.tools.signal,
    extensions: [telemetryExport],
    tags: [
      telemetrySide("server"),
      consoleOutput(process.stdout),
      process.env.OTEL_SERVICE_NAME !== undefined &&
        telemetryService(process.env.OTEL_SERVICE_NAME),
      process.env.VICTORIA_TRACES_URL !== undefined &&
        tracesUrl(new URL(process.env.VICTORIA_TRACES_URL)),
      process.env.VICTORIA_LOGS_URL !== undefined &&
        logsUrl(new URL(process.env.VICTORIA_LOGS_URL)),
      process.env.LOG_LEVEL !== undefined && logLevel(Number(process.env.LOG_LEVEL)),
      process.env.SPAN_HISTORY !== undefined && spanHistory(Number(process.env.SPAN_HISTORY)),
    ],
  });

  let close = once(async () => {
    stop.tools.abort(abortReasons.closed);
    const result = await tools.closed;
    if (result.status === "failed") throw result.error;
    if (result.teardownErrors?.length) throw result.teardownErrors[0];
  });

  try {
    await tools.ready;
    const app = createScope({
      signal: stop.app.signal,
      observe: tools.resolve(observer),
      extensions: [startRequests],
      tags: [
        backendStop(stop.app.signal),
        renderObservation(tools.resolve(renderObserve, { ns: renderNs })),
        browserTelemetry(tools.resolve(browserIngest).ingest),
      ],
    });

    close = once(async () => {
      stop.app.abort(abortReasons.closed);
      const appEnd = await app.closed;
      stop.tools.abort(abortReasons.closed);
      const toolsEnd = await tools.closed;

      for (const result of [appEnd, toolsEnd]) {
        if (result.status === "failed") throw result.error;
        if (result.teardownErrors?.length) throw result.teardownErrors[0];
      }
    });

    await app.ready;
    app.onClose(observeServerPanics(close));
    if (import.meta.hot) {
      import.meta.hot.dispose(close);
      import.meta.hot.on("vite:beforeFullReload", close);
    }
    return createServerHandler(
      { requestContext: app.resolve(startRequests), close },
      { dev: import.meta.env.DEV },
    );
  } catch (error) {
    await close().catch((cleanup) => {
      if (cleanup !== error) process.stderr.write(`close failed: ${String(cleanup)}\n`);
    });
    throw error;
  }
}

let started: ReturnType<typeof main> | undefined;

export default {
  start: () =>
    (started ??= main().catch((error) => {
      started = undefined;
      throw error;
    })),
  fetch: async (request: Request) =>
    (
      await (started ??= main().catch((error) => {
        started = undefined;
        throw error;
      }))
    ).fetch(request),
  close: async () => {
    if (started) await (await started).close();
  },
};
