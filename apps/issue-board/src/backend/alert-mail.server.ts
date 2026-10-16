import { resource, tag } from "@tinker/core";
import { z } from "zod";

import { smtpUrl, mailFrom, type Mail } from "~/components/mail/index.server";

import { smtp } from "./modules";

/** Bound in tests or at the command; the starter sender has no timeout option. */
export const alertMailTimeout = tag<number>({
  label: "outbox.smtpTimeout",
  default: 10_000,
  parse: z.number().int().positive().max(60_000),
});

export const alertMail = resource({
  label: "outbox.sender",
  depends: { url: smtpUrl, from: mailFrom, timeout: alertMailTimeout, smtp },
  factory: async ({ url, from, timeout, smtp }, { defer }): Promise<Mail.Sender> => {
    const transport = smtp.default.createTransport({
      host: url.hostname,
      port: Number(url.port),
      secure: url.protocol === "smtps:",
      pool: true,
      maxConnections: 1,
      connectionTimeout: timeout,
      greetingTimeout: timeout,
      socketTimeout: timeout,
    });
    defer(() => transport.close());

    return {
      async send(message) {
        await transport.sendMail({ from, ...message });
      },
    };
  },
});
