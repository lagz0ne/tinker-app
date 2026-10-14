import type { RouterOptions } from "~/base/router-entry";

export const extensions = [];
export const router: RouterOptions = () => ({});

export async function getRouter() {
  const { createRouterEntry } = await import("~/base/router-entry");
  const { sync, telemetry, pageEvents, tabStop } = await import("@tinker/start/router");

  return createRouterEntry({
    sync,
    telemetry,
    pageEvents,
    tabStop,
    extensions,
    router,
  });
}
