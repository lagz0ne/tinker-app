import { createScope } from "@tinker/core";

import { defineMain, mainErrorCode, checkClosed } from "~/base/main";
import { databaseUrl, databaseStop } from "~/components/database/index.server";
import { mailStartup, smtpUrl, mailFrom } from "~/components/mail/index.server";

import { alertMailTimeout } from "@/backend/alert-mail.server";
import { digestHourUTC } from "@/backend/digest.server";
import { runMailWorker, mailWorkerStop } from "@/backend/outbox.server";

/** Run after the server migrates. The host owns stop and output. */
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
      extensions: [mailStartup],
      tags: [
        mailWorkerStop(signal),
        databaseStop(signal),
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

    const closed = root
      .run(runMailWorker, { tags: [mailWorkerStop(signal)] })
      .then(
        () => root.close({ graceful: true }),
        async (error) => {
          if (signal.aborted && error === signal.reason) return root.close({ graceful: true });

          stderr.write(`outbox worker failed: ${String(error)}\n`);
          await root.close();
          throw error;
        },
      )
      .then((result) => {
        checkClosed(result);
        stdout.write("outbox worker stopped\n");
      })
      .catch((error) => {
        exit(1, error);
        throw error;
      });
    return { closed };
  } catch (error) {
    stderr.write(`worker start failed: ${String(error)}\n`);
    const code = mainErrorCode(error);
    exit(code, error);
    if (code === 1) throw error;
    return { closed: Promise.resolve() };
  }
});
