import { capsule } from "@tinker/core";

import { logConsole } from "./console";
import { queueSink } from "./observer";
import { telemetryService, telemetrySide } from "./settings";

export type { Telemetry } from "./records";
export { exportHealth } from "./health";

/** The tab's telemetry: it sends its own spans and logs to the server's route. */
export const telemetry = {
  browser: capsule({
    label: "telemetry",
    config: { service: telemetryService.required, console: logConsole },
    tags: [telemetrySide("browser")],
    hooks: queueSink,
  }),
};
