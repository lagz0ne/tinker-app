import { createFileRoute } from "@tanstack/react-router";

import { startRequests } from "~/components/requests";

import { healthRead } from "@/transport/health.server";

export const Route = createFileRoute("/api/health")({
  server: {
    middleware: [startRequests.middleware],
    handlers: {
      GET: async ({ context }) =>
        Response.json(await context.session.run(healthRead), {
          headers: { "Cache-Control": "no-store" },
        }),
    },
  },
});
