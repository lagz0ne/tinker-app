import { createScope, type Scope } from "@tinker/core";

import { databaseUrl } from "~/components/database/index.server";
import { mailStartup, smtpUrl, mailFrom } from "~/components/mail/index.server";

import { alertMailTimeout } from "@/backend/alert-mail.server";
import { digestHourUTC } from "@/backend/digest.server";
import { runMailWorker } from "@/backend/outbox.server";

type WorkerInput = {
  presets?: Scope.Preset[];
  env: Readonly<Record<string, string | undefined>>;
  signal: AbortSignal;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
};

/**
 * Run after the server has applied migrations; this command never migrates.
 * @param input - From the Node host; why: bind settings, stop, and output at the entry.
 */
export default async function main(input: WorkerInput) {
  const { env, signal, stdout, stderr } = input;

  const root = createScope({
    signal,
    presets: input.presets,
    observe: { history: 32, log: (entry) => stdout.write(`${JSON.stringify(entry)}\n`) },
    extensions: [mailStartup],
    tags: [
      env.DIGEST_HOUR_UTC !== undefined &&
        digestHourUTC(env.DIGEST_HOUR_UTC.trim() === "" ? NaN : Number(env.DIGEST_HOUR_UTC)),
      env.OUTBOX_SMTP_TIMEOUT_MS !== undefined &&
        alertMailTimeout(Number(env.OUTBOX_SMTP_TIMEOUT_MS)),
      env.DATABASE_URL !== undefined && databaseUrl(new URL(env.DATABASE_URL)),
      env.SMTP_URL !== undefined && smtpUrl(new URL(env.SMTP_URL)),
      env.SMTP_FROM !== undefined && mailFrom(env.SMTP_FROM),
    ],
  });
  await root.ready;
  root.resolve(digestHourUTC);

  const closed = root
    .run(runMailWorker, { signal })
    .then(
      () => root.close({ graceful: true }),
      async (error) => {
        if (signal.aborted && error === signal.reason) return root.closed;

        stderr.write(`outbox worker failed: ${String(error)}\n`);
        await root.close();
        throw error;
      },
    )
    .then((result) => {
      if (result.status === "failed") throw result.error;
      if (result.teardownErrors?.length) throw result.teardownErrors[0];
      stdout.write("outbox worker stopped\n");
    });
  return { closed };
}
