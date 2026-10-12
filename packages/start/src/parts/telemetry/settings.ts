import { LEVELS, tag } from "@tinker/core";
import type { Observe } from "@tinker/core";

import { telemetryEnv } from "#tinker/telemetry-env";

import { readPartEnv } from "../../../lib/part-env.mjs";
import type { Env } from "../../env";
import { raise } from "../../errors";
import type { Telemetry } from "./records";

/** Where this root's records come from; each entry binds its own side. */
export const telemetrySide = tag<Telemetry.Side>({ label: "telemetry.side" });

/** The `service.name` on every record. A tab keeps the default; the server renames its batches. */
export const telemetryService = tag<string>({
  label: "telemetry.service",
  default: telemetryEnv.OTEL_SERVICE_NAME.default,
});

/** Where the server sends spans (OTLP JSON). A tab sends to the ingest route instead. */
export const tracesUrl = tag<URL>({
  label: "telemetry.tracesUrl",
  default: new URL(telemetryEnv.VICTORIA_TRACES_URL.default),
});

/** Where the server sends log lines (JSON lines). A tab sends to the ingest route instead. */
export const logsUrl = tag<URL>({
  label: "telemetry.logsUrl",
  default: new URL(telemetryEnv.VICTORIA_LOGS_URL.default),
});

/** The lowest level Core writes; lower log lines are dropped before they cost a record. */
export const logLevel = tag<Observe.Level>({ label: "telemetry.logLevel", default: LEVELS.info });

/** How many finished spans a root keeps for `root.spans()`; 0 keeps none. */
export const spanHistory = tag<number>({ label: "telemetry.spanHistory", default: 80 });

/**
 * Fills the telemetry tags from the part's env keys, checked once at start (ADR 0113).
 * @param env - From the server entry's copy of process.env; why: the keys to check.
 */
export function readTelemetryConfig(env: Env.Values) {
  const { values, refused } = readPartEnv(telemetryEnv, env);
  if (refused.length > 0) raise("BadSettings", { part: "telemetry", keys: refused });

  return [
    telemetryService(values.OTEL_SERVICE_NAME),
    tracesUrl(new URL(values.VICTORIA_TRACES_URL)),
    logsUrl(new URL(values.VICTORIA_LOGS_URL)),
    logLevel(LEVELS[values.LOG_LEVEL as keyof typeof LEVELS]),
    spanHistory(Number(values.SPAN_HISTORY)),
  ];
}
