import { extension, operation, resource } from "@tinker/core";
import { z } from "zod";

import { smtp } from "./modules";
import { smtpUrl, mailFrom, mailSendTimeout } from "./settings";
import { smtpSockets } from "./sockets.server";

export { smtpUrl, mailFrom, mailSendTimeout } from "./settings";

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

/** Auth has no result stream; this owner drains sends and reports failed delivery. */
export const authMail = resource({
  label: "mail.authWork",
  depends: { send: sendMail },
  factory: ({ send }, { log, defer }) => {
    const running = new Set<Promise<void>>();
    defer(async () => {
      await Promise.all(running);
    });
    return {
      enqueue(input: Mail.Message) {
        const completed = send.settle({ rawInput: input }).then((result) => {
          running.delete(completed);
          if (result.status !== "success") log.error("mail.failed", { status: result.status });
        });
        running.add(completed);
      },
    };
  },
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
