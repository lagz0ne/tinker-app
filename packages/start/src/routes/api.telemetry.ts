import { createFileRoute } from "@tanstack/react-router";

import { telemetryEndpoint } from "../parts/telemetry/ingest.server";
import { startRequests } from "../start";

/** Mounted only while the telemetry part is on (ADR 0106). */
export const Route = createFileRoute("/api/telemetry")({
  server: {
    middleware: [startRequests.middleware],
    handlers: {
      POST: ({ request, context }) => context.session.resolve(telemetryEndpoint).answer(request),
    },
  },
});
