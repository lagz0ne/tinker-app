import { createRouterEntry } from "~/base/router-entry";
import type { RouterOptions } from "~/base/router-entry";
import { telemetry, logConsole } from "~/components/telemetry";

export const extensions = [];
export const router: RouterOptions = {};

export const getRouter = createRouterEntry({
  telemetry,
  toolTags: [logConsole(console)],
  extensions,
  router,
});
