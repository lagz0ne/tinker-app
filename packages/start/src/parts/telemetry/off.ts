import { resource } from "@tinker/core";
import type { Telemetry } from "./records";

/** The telemetry part, off: the telemetry root stays empty, and the app root is not observed. */
export const telemetry: Telemetry.ServerPart = {
  extensions: [],
  tags: [],
  observe: resource({ label: "telemetry.off", factory: () => undefined }),
  appTags: resource({ label: "telemetry.off.appTags", factory: () => [] }),
};
