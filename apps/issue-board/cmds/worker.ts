import { createScope } from "@tinker/core";

import { databaseUrl } from "~/components/database/index.server";
import { mailStartup, smtpUrl, mailFrom } from "~/components/mail/index.server";

import { runMailWorker } from "@/backend/outbox.server";

type WorkerInput = {
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
    observe: { history: 32, log: (entry) => stdout.write(`${JSON.stringify(entry)}\n`) },
    extensions: [mailStartup],
    tags: [
      env.DATABASE_URL !== undefined && databaseUrl(new URL(env.DATABASE_URL)),
      env.SMTP_URL !== undefined && smtpUrl(new URL(env.SMTP_URL)),
      env.SMTP_FROM !== undefined && mailFrom(env.SMTP_FROM),
    ],
  });
  await root.ready;
  const running = root.run(runMailWorker, { signal });
  const closed = running.then(
    async () => {
      const result = await root.close({ graceful: true });
      if (result.status === "failed") throw result.error;
      if (result.teardownErrors?.length) throw result.teardownErrors[0];
      stdout.write("outbox worker stopped\n");
    },
    async (error) => {
      await root.close();
      if (signal.aborted) return;

      stderr.write(`outbox worker failed: ${String(error)}\n`);
      throw error;
    },
  );
  return { closed };
}
