import type { Scope } from "@tinker/core";
import { createScope } from "@tinker/core";
import * as start from "@tinker/start/server";

import { createScopeClose } from "~/base/close";
import { renderObservation } from "~/base/observe";
import { observeServerPanics } from "~/base/panics.server";
import { createServerHandler } from "~/base/server-entry";
import type { ServerEntry } from "~/base/server-entry";
import {
  auth,
  authStartup,
  sendAuthMail,
  sessionDeleted,
  settings as authSettingsFromEnv,
} from "~/components/auth/index.server";
import {
  database,
  databaseSetup,
  settings as databaseSettings,
} from "~/components/database/index.server";
import { bootstrap, readAccount } from "~/components/demo/index.server";
import * as mail from "~/components/mail/index.server";
import { startRequests, backendStop } from "~/components/requests";
import {
  telemetry,
  consoleOutput,
  settings as telemetrySettings,
} from "~/components/telemetry/index.server";

const parts = start.serverParts({ auth, bootstrap, database, readAccount });
const values = { ...process.env };

const appTags = [
  parts,
  authSettingsFromEnv(values),
  databaseSettings(values),
  mail.settings(values),
];

const stop = { tools: new AbortController(), app: new AbortController() };

const tools = createScope({
  signal: stop.tools.signal,
  extensions: telemetry.extensions,
  tags: [telemetrySettings(values), telemetry.tags, consoleOutput(process.stdout)],
});

await tools.ready;

const app: Scope.RootHandle = createScope({
  signal: stop.app.signal,
  observe: tools.resolve(telemetry.observe),
  extensions: [startRequests, authStartup, databaseSetup],
  tags: [
    sendAuthMail((message) => app.resolve(mail.authMail).enqueue(message)),
    sessionDeleted((accountId) => app.run(start.publishAccountNotice, { rawInput: { accountId } })),
    backendStop(stop.app.signal),
    renderObservation(tools.resolve(telemetry.renderObserve, { ns: telemetry.renderNs })),
    appTags,
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
