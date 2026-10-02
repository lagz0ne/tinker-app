import { createFileRoute } from "@tanstack/react-router";
import { startRequests } from "../scaffold/start.ts";
import { receiveTelemetry } from "../scaffold/telemetry/ingest.server.ts";
import { readResult } from "../scaffold/backend/result.server.ts";
export const Route = createFileRoute("/api/telemetry")({
  server: {
    middleware: [startRequests.middleware],
    handlers: {
      POST: async ({ request, context }) =>
        readResult(
          await context.session.settle(receiveTelemetry, {
            input: request,
            signal: context.signal,
          }),
        ),
    },
  },
});
