import type { Env } from "@tinker/start/server";
import { z } from "zod";

import { mailFrom, smtpUrl } from "./mail.server";

const mailEnv = z.object({
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535),
  SMTP_USER: z.string().default(""),
  SMTP_PASSWORD: z.string().default(""),
  SMTP_FROM: z.email(),
});

/**
 * The main validates SMTP keys once; mail units receive typed tags (ADR 0113).
 * @param env - From the app's server entry; why: the keys to check and convert.
 */
export function settings(env: Env.Values) {
  const parsed = mailEnv.safeParse(env);
  if (!parsed.success) {
    throw Object.assign(new Error("BadSettings"), {
      kind: "BadSettings",
      payload: { part: "mail", keys: parsed.error.issues.map((issue) => issue.path.join(".")) },
    });
  }

  const keys = parsed.data;
  const host = keys.SMTP_HOST.includes(":") ? `[${keys.SMTP_HOST}]` : keys.SMTP_HOST;
  const address = `smtp://${host}:${keys.SMTP_PORT}`;
  if (!URL.canParse(address)) {
    throw Object.assign(new Error("BadSettings"), {
      kind: "BadSettings",
      payload: { part: "mail", keys: ["SMTP_HOST"] },
    });
  }

  const smtp = new URL(address);
  smtp.username = keys.SMTP_USER;
  smtp.password = keys.SMTP_PASSWORD;

  return [smtpUrl(smtp), mailFrom(keys.SMTP_FROM)];
}
