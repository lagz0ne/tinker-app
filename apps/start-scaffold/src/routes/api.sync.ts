import { createFileRoute } from "@tanstack/react-router";
import { isError as isCoreError } from "@tinker/core";

import { openSync } from "~/components/auth/index.server";
import { startRequests } from "~/components/requests";
import { cancelledCall } from "~/components/requests/index.server";

/** The copied route owns HTTP; the component owns the request's event stream. */
export const Route = createFileRoute("/api/sync")({
  server: {
    middleware: [startRequests.middleware],
    handlers: {
      GET: async ({ request, context }) => {
        // requestStop owns the body; a call signal would make a shorter child session.
        const result = await context.session.settle(openSync, {
          rawInput: {
            search: new URL(request.url).search,
            lastEventId: request.headers.get("Last-Event-ID"),
          },
        });

        if (result.status === "failed") {
          if (
            isCoreError(result.error, "DataValidationFailed") &&
            result.error.payload.label === openSync.label
          ) {
            return new Response(null, { status: 400 });
          }
          if (Object(result.error).kind === "StreamDenied") {
            return new Response(null, { status: 403 });
          }
          throw result.error;
        }
        if (result.status === "cancelled") return context.session.run(cancelledCall);

        return new Response(result.value, {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
          },
        });
      },
    },
  },
});
