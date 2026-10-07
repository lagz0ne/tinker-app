import { createFileRoute } from "@tanstack/react-router";
import { readResult } from "../backend/result.server";
import { handleAuth } from "../parts/auth/handle.server";
import { startRequests } from "../start";
/** Mounted only while the auth part is on (ADR 0106); the app's auth library answers. */
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
