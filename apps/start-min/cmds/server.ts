import { createScope } from "@tinker/core";
import * as start from "@tinker/start/server";

import { createScopeClose } from "~/base/close";
import { renderObservation } from "~/base/observe";
import { observeServerPanics } from "~/base/panics.server";
import { createServerHandler } from "~/base/server-entry";
import type { ServerEntry } from "~/base/server-entry";
import { startRequests, backendStop } from "~/components/requests";

const values = { ...process.env };
const appTags = [start.auth.settings(values)];
const stop = { tools: new AbortController(), app: new AbortController() };

const tools = createScope({
  signal: stop.tools.signal,
  extensions: start.telemetry.extensions,
  tags: [start.telemetry.settings(values), start.telemetry.tags],
});

await tools.ready;

const app = createScope({
  signal: stop.app.signal,
  observe: tools.resolve(start.telemetry.observe),
  extensions: [startRequests, start.auth.extensions],
  tags: [
    backendStop(stop.app.signal),
    renderObservation(
      tools.resolve(start.telemetry.renderObserve, { ns: start.telemetry.renderNs }),
    ),
    appTags,
    tools.resolve(start.telemetry.appTags),
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
