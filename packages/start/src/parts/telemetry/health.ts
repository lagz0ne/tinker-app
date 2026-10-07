import { data } from "@tinker/core";
import type { Telemetry } from "./records";
/** What the telemetry queue holds, sends, and dropped; the queue alone writes it. */
export const exportHealth = data<Telemetry.Health>({
  label: "telemetry.exportHealth",
  initial: { kind: "idle", pending: 0, dropped: 0 },
});
