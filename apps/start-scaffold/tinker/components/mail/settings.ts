import { tag } from "@tinker/core";
import { z } from "zod";

/** Where the SMTP server is, with its user and password when it needs them. */
export const smtpUrl = tag<URL>({ label: "mail.smtpUrl", parse: z.instanceof(URL) });

/** The sender address on each message. */
export const mailFrom = tag<string>({ label: "mail.from", parse: z.email() });

/** Total time for queueing and all SMTP stages, within the host grace. */
export const mailSendTimeout = tag<number>({
  label: "mail.sendTimeout",
  default: 3000,
  parse: z.number().int().positive().max(3000),
});
