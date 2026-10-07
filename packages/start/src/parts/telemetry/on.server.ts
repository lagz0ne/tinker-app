import { namespace, resource } from "@tinker/core";
import { browserIngest } from "./ingest.server";
import { observer, telemetryExport } from "./observer";
import type { Telemetry } from "./records";
import { telemetrySettings, telemetrySide } from "./settings";

/** The telemetry part, on, for the server entry: server records, and the browser's by its route. */
export const telemetry = {
  extensions: [telemetryExport],
  tags: [telemetrySide("server")],
  observe: observer,
  appTags: browserIngest,
  /** Only the observer and its settings vary by side; the scope queue remains shared. */
  renderObserve: resource({
    ...observer,
    target: "namespace",
    depends: {
      ...observer.depends,
      settings: resource({ ...telemetrySettings, target: "namespace" }),
    },
  }),
  renderNs: namespace({ tags: [telemetrySide("ssr")] }),
} satisfies Telemetry.ServerPart & {
  renderObserve: typeof observer;
  renderNs: ReturnType<typeof namespace>;
};
