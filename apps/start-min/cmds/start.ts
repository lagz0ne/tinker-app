import { createStartEntry } from "~/base/start-entry";
import { startRequests } from "~/components/requests";

import { startInstance as app } from "@/start";

export const startInstance = createStartEntry(async (csrf) => {
  const own = await app.getOptions();
  return {
    ...own,
    requestMiddleware: [csrf, startRequests.middleware, ...(own.requestMiddleware ?? [])],
  };
});
