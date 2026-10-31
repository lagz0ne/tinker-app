import { createFileRoute } from "@tanstack/react-router";

import { handleAuth } from "~/components/auth/index.server";
import { startRequests } from "~/components/requests/index";
import { cancelledCall } from "~/components/requests/index.server";

/** The copied auth route delegates HTTP to its owned handler; the app's auth library answers. */
export const Route = createFileRoute("/api/auth/$")({
  server: {
    middleware: [startRequests.middleware],
    handlers: {
      GET: async ({ request, context }) => {
        const result = await context.session.settle(handleAuth, {
          input: request,
          signal: context.signal,
        });
        if (result.status === "failed") throw result.error;
        if (result.status === "cancelled") return context.session.run(cancelledCall);
        return result.value;
      },
      POST: async ({ request, context }) => {
        const result = await context.session.settle(handleAuth, {
          input: request,
          signal: context.signal,
        });
        if (result.status === "failed") throw result.error;
        if (result.status === "cancelled") return context.session.run(cancelledCall);
        return result.value;
      },
    },
  },
});
