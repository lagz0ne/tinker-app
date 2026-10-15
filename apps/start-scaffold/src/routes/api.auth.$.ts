import { createFileRoute } from "@tanstack/react-router";

import { handleAuth } from "~/components/auth/index.server";
import { startRequests } from "~/components/requests/index";
import { readResult } from "~/components/requests/index.server";

/** The copied auth route delegates HTTP to its owned handler; the app's auth library answers. */
export const Route = createFileRoute("/api/auth/$")({
  server: {
    middleware: [startRequests.middleware],
    handlers: {
      GET: async ({ request, context }) =>
        readResult(
          await context.session.settle(handleAuth, { input: request, signal: context.signal }),
        ),
      POST: async ({ request, context }) =>
        readResult(
          await context.session.settle(handleAuth, { input: request, signal: context.signal }),
        ),
    },
  },
});
