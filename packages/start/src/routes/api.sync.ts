import { createFileRoute } from "@tanstack/react-router";

import { startRequests } from "~/components/requests/index";

import { syncEndpoint } from "../parts/sync/endpoint.server";

/** Mounted only while the sync part is on (ADR 0106). */
export const Route = createFileRoute("/api/sync")({
  server: {
    middleware: [startRequests.middleware],
    handlers: {
      GET: ({ request, context }) => context.session.resolve(syncEndpoint).answer(request),
    },
  },
});
