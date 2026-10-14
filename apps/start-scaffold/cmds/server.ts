import { createScope } from "@tinker/core";
import * as start from "@tinker/start/server";

import { backendStop, createScopeClose, createServerEntry } from "~/base/server";
import * as demo from "~/components/demo/index.server";
import { auth, bootstrap, database, readAccount } from "~/components/demo/index.server";

const parts = { auth, bootstrap, database, readAccount };
const values = { ...process.env };
const appTags = [start.auth.settings(values), demo.settings(values), start.serverParts(parts)];
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
  extensions: [start.startRequests, start.auth.extensions, demo.databaseSetup],
  tags: [backendStop(stop.app.signal), appTags, tools.resolve(start.telemetry.appTags)],
});

const close = createScopeClose({ tools, app }, stop);

await app.ready.catch(close);

if (import.meta.hot) import.meta.hot.dispose(close);

export default createServerEntry({
  requestContext: app.resolve(start.startRequests),
  renderObserve: tools.resolve(start.telemetry.renderObserve, { ns: start.telemetry.renderNs }),
  close,
});
