import { loadRouterParts } from "@tinker/start/router";

import { createRouterEntry } from "~/base/router-entry";
import type { RouterOptions } from "~/base/router-entry";
import { logConsole } from "~/components/telemetry";

export { records, readBatch, readBootstrap, readSnapshot, streamMessage } from "~/components/demo";

export const extensions = [];
export const router: RouterOptions = {};

export const getRouter = createRouterEntry({
  parts: loadRouterParts,
  toolTags: [logConsole(console)],
  extensions,
  router,
});
