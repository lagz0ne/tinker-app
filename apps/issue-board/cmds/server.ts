import { createScope } from "@tinker/core";

import { defineMain, mainErrorCode, checkClosed } from "~/base/main";
import { renderObservation } from "~/base/observe";
import { observeServerPanics } from "~/base/panics.server";
import { createServerHandler, stoppedFetch } from "~/base/server-entry";
import { authStartup, authSettings } from "~/components/auth/index.server";
import {
  databaseSetup,
  databaseMigrationTimeout,
  databaseUrl,
} from "~/components/database/index.server";
import { abortReasons } from "~/components/errors";
import * as mail from "~/components/mail/index.server";
import { startRequests, backendStop } from "~/components/requests";
import {
  syncStartup,
  syncSide,
  bootstrapSlot,
  readAccountSlot,
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

import { readAccount } from "@/demo/backend/auth.server";
import { bootstrap } from "@/demo/backend/sync.server";

/** The host starts the server; importing this command opens nothing. */
// oxlint-disable-next-line complexity -- Commands keep env bindings inline. Tests cover input, startup, exit, and close.
export default defineMain(async ({ env, args, signal, stdout, stderr, exit }) => {
  if (args.length) {
    stderr.write("Usage: tinker serve\n");
    exit(64);
    return { fetch: stoppedFetch, closed: Promise.resolve() };
  }
  try {
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

    await tools.ready;

    try {
      const app = createScope({
        signal: appStop,
        observe: tools.resolve(observer),
        extensions: [startRequests, authStartup, databaseSetup, mail.mailStartup, syncStartup],
        tags: [
          backendStop(appStop),
          syncSide("server"),
          bootstrapSlot(bootstrap),
          readAccountSlot(readAccount),
          env.PUBLIC_ORIGIN !== undefined &&
            env.AUTH_SECRET !== undefined &&
            authSettings({ origin: env.PUBLIC_ORIGIN, secret: env.AUTH_SECRET }),
          env.DATABASE_MIGRATION_TIMEOUT_MS !== undefined &&
            databaseMigrationTimeout(Number(env.DATABASE_MIGRATION_TIMEOUT_MS)),
          env.DATABASE_URL !== undefined && databaseUrl(new URL(env.DATABASE_URL)),
          env.SMTP_URL !== undefined && mail.smtpUrl(new URL(env.SMTP_URL)),
          env.SMTP_FROM !== undefined && mail.mailFrom(env.SMTP_FROM),
          renderObservation(tools.resolve(renderObserve, { ns: renderNs })),
          browserTelemetry(tools.resolve(browserIngest).ingest),
        ],
      });

      let serving = false;

      const closed = app.closed
        .then(async function closeRoots(appEnd) {
          stop.tools.abort(abortReasons.closed);
          const toolsEnd = await tools.closed;

          checkClosed(appEnd);

          checkClosed(toolsEnd);
        })
        .catch((error) => {
          if (!serving) throw error;
          exit(1, error);
        });
      void closed.catch(() => {});

      try {
        await app.ready;
        signal.throwIfAborted(); // Aborted during start: app is closing, so no handler.
        serving = true;
      } catch (error) {
        await closed.catch((cleanup) => {
          if (cleanup !== error) stderr.write(`close failed: ${String(cleanup)}\n`);
        });
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
      try {
        checkClosed(await tools.closed);
      } catch (cleanup) {
        if (cleanup !== error) stderr.write(`close failed: ${String(cleanup)}\n`);
      }
      throw error;
    }
  } catch (error) {
    exit(mainErrorCode(error), error);
    return { fetch: stoppedFetch, closed: Promise.resolve() };
  }
});
