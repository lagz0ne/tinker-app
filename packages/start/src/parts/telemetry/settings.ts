import { resource, tag } from "@tinker/core";
import { readPartEnv } from "../../../lib/part-env.mjs";
import { telemetryEnv } from "#tinker/telemetry-env";
import { env } from "../../env";
import { raise } from "../../errors";
import type { Telemetry } from "./records";

/** Where this root's records come from; each entry binds its own side. */
export const telemetrySide = tag<Telemetry.Side>({ label: "telemetry.side" });

/**
 * The telemetry part's own env keys, read once and checked (ADR 0106).
 * The browser has no storage URLs: it sends to the base's ingest route.
 */
export const telemetrySettings = resource({
  label: "telemetry.settings",
  depends: { env, side: telemetrySide },
  factory: ({ env, side }): Telemetry.Settings => {
    const { values, refused } = readPartEnv(telemetryEnv, env);
    if (refused.length > 0) raise("BadSettings", { part: "telemetry", keys: refused });
    const service = values.OTEL_SERVICE_NAME;
    if (side === "browser") return { side, service };
    return { side, service, traces: values.VICTORIA_TRACES_URL, logs: values.VICTORIA_LOGS_URL };
  },
});
