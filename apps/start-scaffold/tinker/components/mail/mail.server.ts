import { extension, operation, resource } from "@tinker/core";
import { z } from "zod";

import { transaction } from "~/components/database/index.server";

import { smtp } from "./modules";
import { mailOutbox } from "./schema.server";
import { smtpUrl, mailFrom, mailSendTimeout } from "./settings";
import { smtpSockets } from "./sockets.server";

const message = z.strictObject({ to: z.string(), subject: z.string(), text: z.string() });

export declare namespace Mail {
  type Message = z.infer<typeof message>;
  type Sender = { send: (message: Message, options?: { signal?: AbortSignal }) => Promise<void> };
}

export const mail = resource({
  label: "mail.sender",
  depends: { url: smtpUrl, from: mailFrom, timeout: mailSendTimeout, smtp, sockets: smtpSockets },
  factory: async (
    { url, from, timeout, smtp, sockets },
    { defer, clock },
  ): Promise<Mail.Sender> => {
    const user = decodeURIComponent(url.username);
    const optionsForTransport = {
      host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
      port: url.port ? Number(url.port) : undefined,
      secure: url.protocol === "smtps:" || url.port === "465",
      auth: user ? { user, pass: decodeURIComponent(url.password) } : undefined,
      pool: true,
      maxConnections: 1,
      getSocket: sockets.getSocket,
      dnsTimeout: timeout,
      connectionTimeout: timeout,
      greetingTimeout: timeout,
      socketTimeout: timeout,
    };
    let transport = smtp.default.createTransport(optionsForTransport);
    defer(() => transport.close());

    return {
      async send(message, options) {
        options?.signal?.throwIfAborted();

        const cancelled = Promise.withResolvers<never>();

        const abort = () => {
          sockets.abort();

          transport.close();

          transport = smtp.default.createTransport(optionsForTransport);

          cancelled.reject(options?.signal?.reason);
        };

        options?.signal?.addEventListener("abort", abort, { once: true });

        const timer = new AbortController();

        try {
          const sent = transport.sendMail({ from, ...message });

          const deadline = clock.sleep(timeout, timer.signal).then(() => {
            sockets.abort();

            transport.close();

            transport = smtp.default.createTransport(optionsForTransport);

            throw new Error("Mail send total timeout");
          });

          await Promise.race([sent, deadline, cancelled.promise]);
        } finally {
          timer.abort();

          options?.signal?.removeEventListener("abort", abort);
        }
      },
    };
  },
});

export const sendMail = operation({
  label: "sendMail",
  input: message,
  depends: { mail },
  run: async ({ mail }, { input, log }) => {
    await mail.send(input);
    log("mail.completed");
  },
});

/** The caller's write session owns this enqueue and its commit. */
export const enqueueMail = operation({
  label: "mail.enqueue",
  input: message,
  depends: { tx: transaction },
  run: async ({ tx }, { input, random }) => {
    await tx.insert(mailOutbox).values({ ...input, dedupeKey: `mail:${random.uuid()}` });
  },
});

/** Better Auth owns its pool writes; each callback awaits this separate durable call. */
export const authMail = resource({
  label: "mail.authWork",
  depends: { enqueue: enqueueMail },
  factory: ({ enqueue }, { closing }) => ({
    enqueue: (input: Mail.Message) => enqueue.run({ input, signal: closing }),
  }),
});

/** Missing mail config fails before the first send. */
export const mailStartup = extension({
  label: "mail",
  hooks: {
    start({ resolve, next }) {
      resolve(smtpUrl);
      resolve(mailFrom);
      return next();
    },
  },
});
