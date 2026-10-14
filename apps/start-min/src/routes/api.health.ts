import { createFileRoute } from "@tanstack/react-router";

import { health } from "~/components/health";
import { startRequests } from "~/components/requests";
import { readResult } from "~/components/requests/index.server";

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
