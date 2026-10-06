import { createFileRoute } from "@tanstack/react-router";
import { syncEndpoint } from "../parts/sync/endpoint.server.ts";
import { startRequests } from "../start.ts";
/** Mounted only while the sync part is on (ADR 0106). */
export const Route = createFileRoute("/api/sync")({
  server: {
    middleware: [startRequests.middleware],
    handlers: {
      GET: ({ request, context }) => context.session.resolve(syncEndpoint).answer(request),
    },
  },
});
