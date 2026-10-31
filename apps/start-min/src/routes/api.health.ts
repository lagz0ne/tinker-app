import { createFileRoute } from "@tanstack/react-router";

import { health } from "~/components/health";
import { startRequests } from "~/components/requests";
import { cancelledCall } from "~/components/requests/index.server";

export const Route = createFileRoute("/api/health")({
  server: {
    middleware: [startRequests.middleware],
    handlers: {
      GET: async ({ context }) => {
        const result = await context.session.settle(health, { signal: context.signal });
        if (result.status === "failed") throw result.error;
        if (result.status === "cancelled") return context.session.run(cancelledCall);
        return Response.json(result.value, { headers: { "Cache-Control": "no-store" } });
      },
    },
  },
});
