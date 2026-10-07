import { createIsomorphicFn } from "@tanstack/react-start";
import { observer, telemetryExport } from "./observer";
import type { Telemetry } from "./records";
import { telemetrySide } from "./settings";

/** Start compiles one side in: a server render records as "ssr", a tab as "browser". */
const side = createIsomorphicFn()
  .server((): Telemetry.Side => "ssr")
  .client((): Telemetry.Side => "browser");

/** The telemetry part, on, for the router entry. */
export const telemetry: Telemetry.Part = {
  extensions: [telemetryExport],
  tags: [telemetrySide(side())],
  observe: observer,
};
