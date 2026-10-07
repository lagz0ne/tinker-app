import { namespace, resource } from "@tinker/core";
import type { Telemetry } from "./records";

/** The telemetry part, off: the telemetry root stays empty, and the app root is not observed. */
export const telemetry = {
  extensions: [],
  tags: [],
  observe: resource({ label: "telemetry.off", factory: () => undefined }),
  appTags: resource({ label: "telemetry.off.appTags", factory: () => [] }),
  renderObserve: resource({ label: "telemetry.off.render", factory: () => undefined }),
  renderNs: namespace(),
} satisfies Telemetry.ServerPart & {
  renderObserve: Telemetry.Part["observe"];
  renderNs: ReturnType<typeof namespace>;
};
