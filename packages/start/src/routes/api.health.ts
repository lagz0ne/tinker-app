import { createFileRoute } from "@tanstack/react-router";

import { health } from "../backend/health";
import { readResult } from "../backend/result.server";
import { startRequests } from "../start";

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
