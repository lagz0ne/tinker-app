import { createScope, type Scope } from "@tinker/core";

import { once } from "~/base/close";
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
export default async function main() {
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

  /** @param result - From a root's closed promise; why: report its first failure after cleanup. */
  function ended(result: Scope.Result) {
    if (result.status === "failed") throw result.error;
    if (result.teardownErrors?.length) throw result.teardownErrors[0];
  }

  const closeTools = once(async () => {
    stop.tools.abort(abortReasons.closed);
    ended(await tools.closed);
  });

  try {
    await tools.ready;
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
        process.env.PUBLIC_ORIGIN !== undefined &&
          process.env.AUTH_SECRET !== undefined &&
          authSettings({ origin: process.env.PUBLIC_ORIGIN, secret: process.env.AUTH_SECRET }),
        process.env.DATABASE_URL !== undefined && databaseUrl(new URL(process.env.DATABASE_URL)),
        process.env.SMTP_URL !== undefined && mail.smtpUrl(new URL(process.env.SMTP_URL)),
        process.env.SMTP_FROM !== undefined && mail.mailFrom(process.env.SMTP_FROM),
      ],
    });

    const close = once(async () => {
      stop.app.abort(abortReasons.closed);
      const appEnd = await app.closed;
      try {
        await closeTools();
      } finally {
        ended(appEnd);
      }
    });

    try {
      await app.ready;
    } catch (error) {
      await close().catch((cleanup) => {
        if (cleanup !== error) process.stderr.write(`close failed: ${String(cleanup)}\n`);
      });
      throw error;
    }

    app.onClose(observeServerPanics(close));
    return createServerHandler(
      { requestContext: app.resolve(startRequests), close },
      { dev: import.meta.env.DEV },
    );
  } catch (error) {
    await closeTools().catch((cleanup) => {
      if (cleanup !== error) process.stderr.write(`close failed: ${String(cleanup)}\n`);
    });
    throw error;
  }
}
