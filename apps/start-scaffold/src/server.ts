import * as start from "@tinker/start/server";
import { extensions, settings } from "@tinker/start/wiring";

const values = { ...process.env };
const toolTags = [start.telemetry.settings(values), start.telemetry.tags];
const appTags = [start.auth.settings(values), settings(values)];
const stop = { tools: new AbortController(), app: new AbortController() };

const tools = start.createScope({
  signal: stop.tools.signal,
  extensions: start.telemetry.extensions,
  tags: toolTags,
});

await tools.ready;

const app = start.createScope({
  signal: stop.app.signal,
  observe: tools.resolve(start.telemetry.observe),
  extensions: [start.startRequests, start.auth.extensions, extensions],
  tags: [start.backendStop(stop.app.signal), appTags, tools.resolve(start.telemetry.appTags)],
});

const close = start.createScopeClose([
  { scope: tools, stop: stop.tools },
  { scope: app, stop: stop.app },
]);

await app.ready.catch(close);

const server = start.createServerEntry({
  requestContext: app.resolve(start.startRequests),
  renderObserve: tools.resolve(start.telemetry.renderObserve, { ns: start.telemetry.renderNs }),
  close,
});

if (import.meta.hot) import.meta.hot.dispose(close);
export default server;
