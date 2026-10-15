import { createRouterEntry } from "~/base/router-entry";
import type { RouterOptions } from "~/base/router-entry";
import { telemetry, logConsole } from "~/components/telemetry";

const extensions: [] = [];
const router: RouterOptions = {};

export const getRouter = createRouterEntry({
  telemetry,
  toolTags: [logConsole(console)],
  extensions,
  router,
});
