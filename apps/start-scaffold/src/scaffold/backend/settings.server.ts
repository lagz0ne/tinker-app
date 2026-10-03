import { z } from "zod";
import { raise } from "../errors.ts";
const telemetrySettings = z.object({
  VICTORIA_TRACES_URL: z
    .url({ protocol: /^https?$/ })
    .default("http://127.0.0.1:10428/insert/opentelemetry/v1/traces"),
  VICTORIA_LOGS_URL: z
    .url({ protocol: /^https?$/ })
    .default("http://127.0.0.1:9428/insert/jsonline"),
  OTEL_SERVICE_NAME: z.string().min(1).default("start-scaffold"),
});
const liveSettings = z.object({
  PUBLIC_ORIGIN: z.url(),
  AUTH_SECRET: z.string().min(32),
  DATABASE_URL: z.string().min(1),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().positive(),
  SMTP_USER: z.string(),
  SMTP_PASSWORD: z.string(),
  SMTP_FROM: z.email(),
});
/**
 * @param env - From the entry environment values; why: validate app settings once.
 */
export function readSettings(env: Record<string, string | undefined>) {
  const telemetry = telemetrySettings.safeParse(env);
  if (!telemetry.success)
    raise("BadSettings", { keys: telemetry.error.issues.map((issue) => issue.path.join(".")) });
  const storage = {
    side: "server",
    level: "info",
    service: telemetry.data.OTEL_SERVICE_NAME,
    traces: telemetry.data.VICTORIA_TRACES_URL,
    logs: telemetry.data.VICTORIA_LOGS_URL,
  } as const;
  const parsed = liveSettings.safeParse(env);
  if (!parsed.success)
    raise("BadSettings", { keys: parsed.error.issues.map((issue) => issue.path.join(".")) });
  const value = parsed.data;
  return {
    telemetry: storage,
    origin: value.PUBLIC_ORIGIN,
    secret: value.AUTH_SECRET,
    database: { url: value.DATABASE_URL, migrations: "drizzle" },
    mail: {
      host: value.SMTP_HOST,
      port: value.SMTP_PORT,
      user: value.SMTP_USER,
      password: value.SMTP_PASSWORD,
      from: value.SMTP_FROM,
    },
  };
}
