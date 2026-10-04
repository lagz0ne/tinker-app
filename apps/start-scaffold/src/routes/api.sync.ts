import { createFileRoute } from "@tanstack/react-router";
import { isError } from "@tinker/core";
import { openSync } from "../scaffold/backend/stream.ts";
import { startRequests } from "../scaffold/start.ts";
import { isError as isAppError } from "../errors.ts";
import { streamRequest, streamCursor } from "../scaffold/protocol.ts";
import { readResult } from "../scaffold/backend/result.server.ts";
export const Route = createFileRoute("/api/sync")({
  server: {
    middleware: [startRequests.middleware],
    handlers: {
      GET: async ({ request, context }) => {
        let cursor;
        try {
          const { search, lastEventId } = streamRequest.parse({
            search: new URL(request.url).search,
            lastEventId: request.headers.get("Last-Event-ID"),
          });
          const supplied = lastEventId || new URLSearchParams(search).get("cursor");
          cursor = streamCursor.parse(
            supplied ? JSON.parse(supplied) : { public: 0, private: null },
          );
        } catch {
          return new Response(null, { status: 400 });
        }
        /** requestStop already binds cancellation; a call signal would close a shorter child session. */
        const result = await context.session.settle(openSync, { input: { cursor } });
        if (result.status === "failed") {
          if (isAppError(result.error, "StreamDenied")) return new Response(null, { status: 403 });
          if (isError(result.error, "DataValidationFailed"))
            return new Response(null, { status: 400 });
        }
        return new Response(readResult(result), {
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
