import { createFileRoute } from "@tanstack/react-router";
import { isError } from "@tinker/core";
import { openSync } from "../scaffold/backend/stream.ts";
import { startRequests } from "../scaffold/start.ts";
import { isError as isAppError } from "../errors.ts";
import { readResult } from "../scaffold/backend/result.server.ts";
export const Route = createFileRoute("/api/sync")({
  server: {
    middleware: [startRequests.middleware],
    handlers: {
      GET: async ({ request, context }) => {
        /** requestStop already binds cancellation; a call signal would close a shorter child session. */
        const result = await context.session.settle(openSync, {
          rawInput: {
            search: new URL(request.url).search,
            lastEventId: request.headers.get("Last-Event-ID"),
          },
        });
        if (result.status === "failed") {
          if (isAppError(result.error, "StreamDenied")) return new Response(null, { status: 403 });
          if (isError(result.error, "DataValidationFailed"))
            return new Response(null, { status: 400 });
        }
        return readResult(result);
      },
    },
  },
});
