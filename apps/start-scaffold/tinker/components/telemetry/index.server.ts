import { namespace, resource } from "@tinker/core";

import { browserIngest } from "./ingest.server";
import { observer, telemetryExport } from "./observer";
import type { Telemetry } from "./records";
import { settings, telemetrySide } from "./settings";

/** The telemetry part, on, for the server entry: server records, and the browser's by its route. */
export const telemetry = {
  extensions: [telemetryExport],
  tags: [telemetrySide("server")],
  observe: observer,
  appTags: browserIngest,
  settings: settings,
  /** Only the observer varies by side; the scope queue remains shared. */
  renderObserve: resource({ ...observer, target: "namespace" }),
  renderNs: namespace({ tags: [telemetrySide("ssr")] }),
} satisfies Telemetry.ServerPart & {
  renderObserve: typeof observer;
  renderNs: ReturnType<typeof namespace>;
};

export type { Telemetry } from "./records";
export { observer, telemetryExport, ingestTelemetry, flushTelemetry } from "./observer";
export { consoleOutput, logConsole } from "./console";

export {
  telemetryBody,
  receiveTelemetry,
  browserIngest,
  browserTelemetry,
  telemetryOrigin,
} from "./ingest.server";

export { exportHealth } from "./health";

export { settings } from "./settings";
