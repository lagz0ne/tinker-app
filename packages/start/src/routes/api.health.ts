import { createFileRoute } from "@tanstack/react-router";
import { startRequests } from "../start";
import { readResult } from "../backend/result.server";
import { health } from "../backend/health";

export const Route = createFileRoute("/api/health")({
  server: {
    middleware: [startRequests.middleware],
    handlers: {
      GET: async ({ context }) =>
        Response.json(
          readResult(await context.session.settle(health, { signal: context.signal })),
          {
            headers: { "Cache-Control": "no-store" },
          },
        ),
    },
  },
});
