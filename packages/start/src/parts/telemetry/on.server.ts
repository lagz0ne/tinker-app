import { browserIngest } from "./ingest.server.ts";
import { observer, telemetryExport } from "./observer.ts";
import type { Telemetry } from "./records.ts";
import { telemetrySide } from "./settings.ts";

/** The telemetry part, on, for the server entry: server records, and the browser's by its route. */
export const telemetry: Telemetry.ServerPart = {
  extensions: [telemetryExport],
  tags: [telemetrySide("server")],
  observe: observer,
  appTags: browserIngest,
};
