import { operation, resource, tag } from "@tinker/core";
import { z } from "zod";

import { smtp } from "./modules";

const message = z.strictObject({ to: z.string(), subject: z.string(), text: z.string() });

export declare namespace Mail {
  type Message = z.infer<typeof message>;
  type Sender = { send: (message: Message) => Promise<void> };
}

/** Where the SMTP server is, with its user and password when it needs them. */
export const smtpUrl = tag<URL>({ label: "mail.smtpUrl" });

/** The sender address on each message. */
export const mailFrom = tag<string>({ label: "mail.from" });

export const mail = resource({
  label: "mail.sender",
  depends: { url: smtpUrl, from: mailFrom, smtp },
  factory: async ({ url, from, smtp }, { defer }): Promise<Mail.Sender> => {
    const { default: nodemailer } = smtp;
    const user = decodeURIComponent(url.username);
    const transport = nodemailer.createTransport({
      host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
      pool: true,
      port: url.port ? Number(url.port) : undefined,
      secure: url.protocol === "smtps:" || url.port === "465",
      auth: user ? { user, pass: decodeURIComponent(url.password) } : undefined,
    });
    defer(() => transport.close());
    return {
      send: async (message) => {
        await transport.sendMail({ from, ...message });
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
