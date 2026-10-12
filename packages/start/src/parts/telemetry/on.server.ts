import { namespace, resource } from "@tinker/core";

import { consoleOutput } from "./console";
import { browserIngest } from "./ingest.server";
import { observer, telemetryExport } from "./observer";
import type { Telemetry } from "./records";
import { readTelemetryConfig, telemetrySide } from "./settings";

/** The telemetry part, on, for the server entry: server records, and the browser's by its route. */
export const telemetry = {
  extensions: [telemetryExport],
  tags: [telemetrySide("server"), consoleOutput(process.stdout)],
  observe: observer,
  appTags: browserIngest,
  settings: readTelemetryConfig,
  /** Only the observer varies by side; the scope queue remains shared. */
  renderObserve: resource({ ...observer, target: "namespace" }),
  renderNs: namespace({ tags: [telemetrySide("ssr")] }),
} satisfies Telemetry.ServerPart & {
  renderObserve: typeof observer;
  renderNs: ReturnType<typeof namespace>;
};
