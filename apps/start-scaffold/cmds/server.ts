import { createScope, type Scope } from "@tinker/core";

import { renderObservation } from "~/base/observe";
import { observeServerPanics } from "~/base/panics.server";
import { createServerHandler } from "~/base/server-entry";
import {
  authStartup,
  authSettings,
  sendAuthMail,
  sessionDeleted,
} from "~/components/auth/index.server";
import { databaseSetup, databaseUrl } from "~/components/database/index.server";
import { abortReasons } from "~/components/errors";
import * as mail from "~/components/mail/index.server";
import { startRequests, backendStop } from "~/components/requests";
import {
  syncStartup,
  syncSide,
  bootstrapSlot,
  readAccountSlot,
  publishAccountNotice,
} from "~/components/sync/index.server";
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

import { bootstrap, readAccount } from "@/demo/index.server";

/** The host starts the server; importing this command opens nothing. */
// oxlint-disable-next-line complexity -- Cmd seam keeps Duke's inline env !== undefined && tag(...) list in plain view; deliberately untested glue.
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
  signal.throwIfAborted();
  const stop = { tools: new AbortController(), app: new AbortController() };
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

  const cancelled = Promise.withResolvers<never>();
  const abort = () => {
    stop.app.abort(signal.reason);
    cancelled.reject(signal.reason);
  };
  void cancelled.promise.catch(() => {});
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();

  try {
    await Promise.race([tools.ready, cancelled.promise]);
    signal.throwIfAborted();
    const app = createScope({
      signal: stop.app.signal,
      observe: tools.resolve(observer),
      extensions: [startRequests, authStartup, databaseSetup, mail.mailStartup, syncStartup],
      tags: [
        backendStop(stop.app.signal),
        renderObservation(tools.resolve(renderObserve, { ns: renderNs })),
        browserTelemetry(tools.resolve(browserIngest).ingest),
        syncSide("server"),
        bootstrapSlot(bootstrap),
        readAccountSlot(readAccount),
        sendAuthMail((message, ctx) => ctx.resolve(mail.authMail).enqueue(message)),
        sessionDeleted((accountId, ctx) =>
          ctx.run(publishAccountNotice, { rawInput: { accountId } }),
        ),
        env.PUBLIC_ORIGIN !== undefined &&
          env.AUTH_SECRET !== undefined &&
          authSettings({ origin: env.PUBLIC_ORIGIN, secret: env.AUTH_SECRET }),
        env.DATABASE_URL !== undefined && databaseUrl(new URL(env.DATABASE_URL)),
        env.SMTP_URL !== undefined && mail.smtpUrl(new URL(env.SMTP_URL)),
        env.SMTP_FROM !== undefined && mail.mailFrom(env.SMTP_FROM),
      ],
    });

    const closed = app.closed.then(async function closeRoots(appEnd) {
      stop.tools.abort(abortReasons.closed);
      const toolsEnd = await tools.closed;
      signal.removeEventListener("abort", abort);
      ended(appEnd);
      ended(toolsEnd);
    });
    void closed.catch(() => {});

    try {
      await Promise.race([app.ready, cancelled.promise]);
      signal.throwIfAborted();
      app.onClose(observeServerPanics(abort, closed, stderr));
      return {
        fetch: createServerHandler(
          { requestContext: app.resolve(startRequests) },
          { dev: import.meta.env.DEV },
        ).fetch,
        closed,
      };
    } catch (error) {
      stop.app.abort(error);
      await app.close();
      await closed.catch((cleanup) => {
        if (cleanup !== error) stderr.write(`close failed: ${String(cleanup)}\n`);
      });
      throw error;
    }
  } catch (error) {
    stop.tools.abort(error);
    await tools.close();
    signal.removeEventListener("abort", abort);
    try {
      ended(await tools.closed);
    } catch (cleanup) {
      if (cleanup !== error) stderr.write(`close failed: ${String(cleanup)}\n`);
    }
    throw error;
  }
}
