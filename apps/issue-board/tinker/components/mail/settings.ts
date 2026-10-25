import { tag } from "@tinker/core";
import { z } from "zod";

/** Where the SMTP server is, with its user and password when it needs them. */
export const smtpUrl = tag({ label: "mail.smtpUrl", parse: z.instanceof(URL) });

/** The sender address on each message. */
export const mailFrom = tag({ label: "mail.from", parse: z.email() });

/** Total time after acquiring a sender, across all SMTP stages, within the host grace. */
export const mailSendTimeout = tag<number>({
  label: "mail.sendTimeout",
  default: 3000,
  parse: z.number().int().positive().max(3000),
});

/** Maximum SMTP senders; excess sends wait without starting their deadline. */
export const mailMaxSenders = tag<number>({
  label: "mail.maxSenders",
  default: 4,
  parse: z.number().int().positive(),
});
