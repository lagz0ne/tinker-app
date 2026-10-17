import { resource, tag } from "@tinker/core";
import { z } from "zod";

import { smtpUrl, mailFrom, smtpSockets, type Mail } from "~/components/mail/index.server";

import { smtp } from "./modules";

/** Bound in tests or at the command; the starter sender has no timeout option. */
export const alertMailTimeout = tag<number>({
  label: "outbox.smtpTimeout",
  default: 3000,
  parse: z.number().int().positive().max(3000),
});

export const alertMail = resource({
  label: "outbox.sender",
  depends: { url: smtpUrl, from: mailFrom, timeout: alertMailTimeout, smtp, sockets: smtpSockets },
  factory: async (
    { url, from, timeout, smtp, sockets },
    { defer, clock },
  ): Promise<Mail.Sender> => {
    const user = decodeURIComponent(url.username);
    const options = {
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
    let transport = smtp.default.createTransport(options);
    defer(() => transport.close());

    return {
      async send(message) {
        const timer = new AbortController();
        const sent = transport.sendMail({ from, ...message });
        const deadline = clock.sleep(timeout, timer.signal).then(() => {
          sockets.abort();
          transport.close();
          transport = smtp.default.createTransport(options);
          throw new Error("Alert send total timeout");
        });
        try {
          await Promise.race([sent, deadline]);
        } finally {
          timer.abort();
        }
      },
    };
  },
});
