import { namespace, resource } from "@tinker/core";

import { observer } from "./observer";
import { telemetrySide } from "./settings";

/** Each render has its own observer namespace; the tools queue remains shared. */
export const renderObserve = resource({ ...observer, target: "namespace" });
export const renderNs = namespace({ tags: [telemetrySide("ssr")] });

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

export {
  telemetrySide,
  telemetryService,
  tracesUrl,
  logsUrl,
  logLevel,
  spanHistory,
} from "./settings";

export {
  telemetryWorker,
  telemetryThread,
  threadRing,
  threadExport,
  threadObserver,
  threadRenderObserve,
  threadIngest,
} from "./thread.server";

export type { ThreadSettings, ThreadMessage, ThreadRing, ThreadWorker } from "./thread.server";
export { threadDrain } from "./drain.server";
