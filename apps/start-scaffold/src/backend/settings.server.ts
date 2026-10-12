import type { Env } from "@tinker/start/server";
import { z } from "zod";

import { raise } from "@/errors";

import { databaseUrl } from "./database.server";
import { mailFrom, smtpUrl } from "./mail.server";

const appEnv = z.object({
  DATABASE_URL: z.url(),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535),
  SMTP_USER: z.string().default(""),
  SMTP_PASSWORD: z.string().default(""),
  SMTP_FROM: z.email(),
});

/**
 * Turns env into the typed tags the app's units need (ADR 0113). The base calls it once, at
 * start; mail and the database never see env.
 * @param env - From the base's server entry; why: the keys to check and convert.
 */
export function settings(env: Env.Values) {
  const parsed = appEnv.safeParse(env);
  if (!parsed.success) {
    raise("BadSettings", {
      part: "app",
      keys: parsed.error.issues.map((issue) => issue.path.join(".")),
    });
  }

  const keys = parsed.data;
  const host = keys.SMTP_HOST.includes(":") ? `[${keys.SMTP_HOST}]` : keys.SMTP_HOST;
  const address = `smtp://${host}:${keys.SMTP_PORT}`;
  if (!URL.canParse(address)) raise("BadSettings", { part: "app", keys: ["SMTP_HOST"] });

  const smtp = new URL(address);
  smtp.username = keys.SMTP_USER;
  smtp.password = keys.SMTP_PASSWORD;

  return [databaseUrl(new URL(keys.DATABASE_URL)), smtpUrl(smtp), mailFrom(keys.SMTP_FROM)];
}
