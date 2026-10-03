import { data, tag } from "@tinker/core";
import type { Telemetry } from "./records.ts";
export const frontendSpans = tag<() => Telemetry.Row[]>({ label: "frontend.spans" });
export const exportHealth = data<Telemetry.Health>({
  label: "telemetry.exportHealth",
  initial: { kind: "idle", pending: 0, dropped: 0 },
});
export const telemetrySettings = tag<Telemetry.Settings>({ label: "telemetry.settings" });
