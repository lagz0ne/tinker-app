import { createIsomorphicFn } from "@tanstack/react-start";
import { observer, telemetryExport } from "./observer.ts";
import type { Telemetry } from "./records.ts";
import { telemetrySide } from "./settings.ts";

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
