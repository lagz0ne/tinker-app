import { createScope } from "@tinker/core";

import { defineMain, mainErrorCode, checkClosed } from "~/base/main";
import {
  databaseSetup,
  databaseMigrationTimeout,
  databaseUrl,
  databaseStop,
  databaseConnectTimeout,
  databaseLockTimeout,
  databaseStatementTimeout,
} from "~/components/database/index.server";
import {
  mailStartup,
  smtpUrl,
  mailFrom,
  mailSendTimeout as alertMailTimeout,
  mailWorkerStop,
  mailLeaseMs,
} from "~/components/mail/index.server";
import {
  observer,
  telemetryExport,
  telemetrySide,
  telemetryService,
  tracesUrl,
  logsUrl,
  spanHistory,
} from "~/components/telemetry/index.server";

import { digestHourUTC } from "@/backend/digest.server";
import { runMailWorker } from "@/backend/outbox.server";

/** All processes await the shared migration owner; the host owns stop and output. */
// oxlint-disable-next-line complexity -- Native entry keeps each typed config binding inline, as the server does.
export default defineMain(async ({ env, args, signal, stdout, stderr, exit }) => {
  if (args.length) {
    stderr.write("Usage: worker\n");
    exit(64);
    return { closed: Promise.resolve() };
  }
  try {
    const exporting = !!(env.VICTORIA_TRACES_URL || env.VICTORIA_LOGS_URL);
    const tools = createScope({
      extensions: exporting ? [telemetryExport] : [],
      tags: [
        telemetrySide("worker"),
        telemetryService(env.OTEL_SERVICE_NAME ?? "tinker-worker"),
        spanHistory(env.SPAN_HISTORY === undefined ? 32 : Number(env.SPAN_HISTORY)),
        env.VICTORIA_TRACES_URL !== undefined && tracesUrl(new URL(env.VICTORIA_TRACES_URL)),
        env.VICTORIA_LOGS_URL !== undefined && logsUrl(new URL(env.VICTORIA_LOGS_URL)),
      ],
    });
    try {
      await tools.ready;
      const observed = exporting ? tools.resolve(observer) : undefined;
      const root = createScope({
        observe: {
          ...observed,
          history: tools.resolve(spanHistory),
          log: (entry) => {
            stdout.write(`${JSON.stringify(entry)}\n`);
            observed?.log?.(entry);
          },
        },
        extensions: [databaseSetup, mailStartup],
        tags: [
          env.DATABASE_MIGRATION_TIMEOUT_MS !== undefined &&
            databaseMigrationTimeout(Number(env.DATABASE_MIGRATION_TIMEOUT_MS)),
          mailWorkerStop(signal),
          env.OUTBOX_LEASE_MS !== undefined && mailLeaseMs(Number(env.OUTBOX_LEASE_MS)),
          databaseStop(signal),
          databaseConnectTimeout(500),
          databaseLockTimeout(500),
          databaseStatementTimeout(750),
          env.DIGEST_HOUR_UTC !== undefined &&
            digestHourUTC(env.DIGEST_HOUR_UTC.trim() === "" ? NaN : Number(env.DIGEST_HOUR_UTC)),
          env.OUTBOX_SMTP_TIMEOUT_MS !== undefined &&
            alertMailTimeout(Number(env.OUTBOX_SMTP_TIMEOUT_MS)),
          env.DATABASE_URL !== undefined && databaseUrl(new URL(env.DATABASE_URL)),
          env.SMTP_URL !== undefined && smtpUrl(new URL(env.SMTP_URL)),
          env.SMTP_FROM !== undefined && mailFrom(env.SMTP_FROM),
        ],
      });
      try {
        await root.ready;
        root.resolve(databaseUrl);
      } catch (error) {
        await root.close();
        throw error;
      }

      // The repeated call tag opens a child session; the root tag supplies the same stop signal.
      const closed = root
        .run(runMailWorker, { tags: [mailWorkerStop(signal)] })
        .then(
          () => root.close({ graceful: true }),
          async (error) => {
            if (signal.aborted && error === signal.reason) return root.close({ graceful: true });

            await root.close();
            exit(1, error);
          },
        )
        .then((result) => {
          if (!result) return;
          checkClosed(result);
          stdout.write("outbox worker stopped\n");
        })
        .catch((error) => {
          exit(1, error);
        })
        .finally(async () => {
          checkClosed(await tools.close({ graceful: true }));
        })
        .catch((error) => {
          exit(1, error);
        });
      return { closed };
    } catch (error) {
      await tools.close({ graceful: true });
      throw error;
    }
  } catch (error) {
    exit(mainErrorCode(error), error);
    return { closed: Promise.resolve() };
  }
});
