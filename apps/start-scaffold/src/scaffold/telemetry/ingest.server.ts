import { operation, tag } from "@tinker/core";
import { telemetryBatch } from "./records.ts";
import type { Telemetry } from "./records.ts";
import { backendStop, requestStop } from "../backend/lifetime.ts";
import { raise } from "../errors.ts";

/** Borrowed from the backend telemetry root. Requests neither create nor close that owner. */
export const browserTelemetry = tag<(batch: Telemetry.Batch) => Promise<void>>({
  label: "telemetry.browserIngest",
});
/** A live host binds its public origin; null is the isolated localhost/HTTPS preview proof. */
export const telemetryOrigin = tag<string | null>({ label: "telemetry.origin" });
export const receiveTelemetry = operation({
  label: "telemetry.receive",
  depends: {
    ingest: browserTelemetry.required,
    backendStop: backendStop.required,
    requestStop: requestStop.required,
  },
  input: telemetryBatch,
  run: async ({ ingest, backendStop, requestStop }, ctx) => {
    if (backendStop.aborted || requestStop.aborted || ctx.signal.aborted) raise("Cancelled", {});
    await ingest(ctx.input);
  },
});
