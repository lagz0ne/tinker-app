import { createScope } from "@tinker/core";

import { defineMain, checkClosed } from "~/base/main";
import {
  databaseSetup,
  databaseMigrationTimeout,
  databaseUrl,
  databaseStop,
  databaseConnectTimeout,
  databaseLockTimeout,
  databaseStatementTimeout,
} from "~/components/database/index.server";
import { mailStartup, smtpUrl, mailFrom } from "~/components/mail/index.server";
import { mailSendTimeout as alertMailTimeout } from "~/components/mail/index.server";
import { mailWorkerStop, mailLeaseMs } from "~/components/mail/index.server";
import { runMailWorker } from "~/components/mail/index.server";

/** All processes await the shared migration owner; the host owns stop and output. */
// oxlint-disable-next-line complexity -- Native entry keeps each typed config binding inline, as the server does.
export default defineMain(async ({ env, args, signal, stdout, stderr, exit }) => {
  if (args.length) {
    stderr.write("Usage: worker\n");
    exit(64);
    return { closed: Promise.resolve() };
  }
  try {
    const root = createScope({
      observe: { history: 32, log: (entry) => stdout.write(`${JSON.stringify(entry)}\n`) },
      extensions: [databaseSetup, mailStartup],
      tags: [
        env.DATABASE_MIGRATION_TIMEOUT_MS !== undefined &&
          databaseMigrationTimeout(Number(env.DATABASE_MIGRATION_TIMEOUT_MS)),
        mailWorkerStop(signal),
        env.OUTBOX_LEASE_MS !== undefined && mailLeaseMs(Number(env.OUTBOX_LEASE_MS)),
        databaseStop(signal),
        databaseConnectTimeout(1000),
        databaseLockTimeout(500),
        databaseStatementTimeout(1000),
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
      });
    return { closed };
  } catch (error) {
    let code = 1;
    if (error && typeof error === "object") {
      if ("kind" in error && ["MissingTag", "DataValidationFailed"].includes(String(error.kind))) {
        code = 78;
      }
      if ("code" in error && error.code === "ERR_INVALID_URL") code = 78;
    }
    exit(code, error);
    return { closed: Promise.resolve() };
  }
});
