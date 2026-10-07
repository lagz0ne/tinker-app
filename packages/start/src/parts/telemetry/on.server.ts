import { browserIngest } from "./ingest.server";
import { observer, telemetryExport } from "./observer";
import type { Telemetry } from "./records";
import { telemetrySide } from "./settings";

/** The telemetry part, on, for the server entry: server records, and the browser's by its route. */
export const telemetry: Telemetry.ServerPart = {
  extensions: [telemetryExport],
  tags: [telemetrySide("server")],
  observe: observer,
  appTags: browserIngest,
};
