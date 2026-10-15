import { createScope } from "@tinker/core";

import { createScopeClose } from "~/base/close";
import { renderObservation } from "~/base/observe";
import { observeServerPanics } from "~/base/panics.server";
import { createServerHandler } from "~/base/server-entry";
import type { ServerEntry } from "~/base/server-entry";
import { startRequests, backendStop } from "~/components/requests";
import {
  telemetry,
  consoleOutput,
  settings as telemetrySettings,
} from "~/components/telemetry/index.server";

const values = { ...process.env };
const stop = { tools: new AbortController(), app: new AbortController() };

const tools = createScope({
  signal: stop.tools.signal,
  extensions: telemetry.extensions,
  tags: [telemetrySettings(values), telemetry.tags, consoleOutput(process.stdout)],
});

await tools.ready;

const app = createScope({
  signal: stop.app.signal,
  observe: tools.resolve(telemetry.observe),
  extensions: [startRequests],
  tags: [
    backendStop(stop.app.signal),
    renderObservation(tools.resolve(telemetry.renderObserve, { ns: telemetry.renderNs })),
    tools.resolve(telemetry.appTags),
  ],
});

const close = createScopeClose({ tools, app }, stop);

await app.ready.catch(close);

const server = {
  requestContext: app.resolve(startRequests),
  close,
} satisfies ServerEntry.Handle;

observeServerPanics(server);

if (import.meta.hot) {
  import.meta.hot.dispose(close);
  import.meta.hot.on("vite:beforeFullReload", close);
}

export { close };
export default createServerHandler(server);
