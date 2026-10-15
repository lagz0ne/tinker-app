import { LEVELS, tag } from "@tinker/core";
import type { Observe } from "@tinker/core";
import { z } from "zod";

import { raise } from "~/components/errors";
import type { Env } from "~/components/errors";

import component from "./component.json";
import type { Telemetry } from "./records";

const telemetryEnv = component.env;

export const telemetrySide = tag<Telemetry.Side>({ label: "telemetry.side" });

export const telemetryService = tag<string>({
  label: "telemetry.service",
  default: telemetryEnv.OTEL_SERVICE_NAME.default,
});

export const tracesUrl = tag<URL>({
  label: "telemetry.tracesUrl",
  default: new URL(telemetryEnv.VICTORIA_TRACES_URL.default),
});

export const logsUrl = tag<URL>({
  label: "telemetry.logsUrl",
  default: new URL(telemetryEnv.VICTORIA_LOGS_URL.default),
});

export const logLevel = tag<Observe.Level>({ label: "telemetry.logLevel", default: LEVELS.info });
export const spanHistory = tag<number>({ label: "telemetry.spanHistory", default: 80 });

const telemetryInput = z.object({
  VICTORIA_TRACES_URL: z.url({ protocol: /^https?$/ }),
  VICTORIA_LOGS_URL: z.url({ protocol: /^https?$/ }),
  OTEL_SERVICE_NAME: z.string(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]),
  SPAN_HISTORY: z
    .string()
    .regex(/^\d+$/)
    .refine((value) => Number.isSafeInteger(Number(value))),
});

/**
 * @param env - From the command's copy of process.env; why: check and convert telemetry's five keys.
 */
export function settings(env: Env.Values) {
  const values = Object.fromEntries(
    Object.entries(telemetryEnv).map(([key, row]) => [key, env[key] || row.default]),
  );
  const parsed = telemetryInput.safeParse(values);
  if (!parsed.success) {
    raise("BadSettings", {
      part: "telemetry",
      keys: parsed.error.issues.map((issue) => String(issue.path[0])),
    });
  }

  return [
    telemetryService(parsed.data.OTEL_SERVICE_NAME),
    tracesUrl(new URL(parsed.data.VICTORIA_TRACES_URL)),
    logsUrl(new URL(parsed.data.VICTORIA_LOGS_URL)),
    logLevel(LEVELS[parsed.data.LOG_LEVEL]),
    spanHistory(Number(parsed.data.SPAN_HISTORY)),
  ];
}
