import { observer, telemetryExport } from "./observer";
import type { Telemetry } from "./records";
import { telemetrySide } from "./settings";

/** The browser telemetry part supplied by the command. */
export const telemetry: Telemetry.Part = {
  extensions: [telemetryExport],
  tags: [telemetrySide("browser")],
  observe: observer,
};

export type { Telemetry } from "./records";
export { observer, telemetryExport, ingestTelemetry, flushTelemetry } from "./observer";
export { consoleOutput, logConsole } from "./console";
export { exportHealth } from "./health";
