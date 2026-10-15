export type { Telemetry } from "./records";
export { observer, telemetryExport, ingestTelemetry, flushTelemetry } from "./observer";
export { consoleOutput, logConsole } from "./console";
export { exportHealth } from "./health";

export {
  telemetrySide,
  telemetryService,
  tracesUrl,
  logsUrl,
  logLevel,
  spanHistory,
} from "./settings";
