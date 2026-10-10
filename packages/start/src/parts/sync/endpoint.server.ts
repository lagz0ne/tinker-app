import { isError as isCoreError, resource } from "@tinker/core";
import { readResult } from "../../backend/result.server";
import { isError } from "../../errors";
import { openSync } from "./stream.server";

/**
 * The reply of `GET /api/sync` (ADR 0103). The cursor comes from `Last-Event-ID` (a reconnect),
 * else `?cursor=`, else the start; a cursor that does not read is a 400, another account's is a
 * 403. The stream answers with Server-Sent Events.
 */
export const syncEndpoint = resource({
  label: "sync.endpoint",
  target: "session",
  depends: { open: openSync.controller },
  factory: ({ open }) => {
    return {
      async answer(request: Request): Promise<Response> {
        /** requestStop already binds cancellation; a call signal would close a shorter child session. */
        const result = await open.settle({
          rawInput: {
            search: new URL(request.url).search,
            lastEventId: request.headers.get("Last-Event-ID"),
          },
        });
        if (result.status === "failed") {
          if (
            isCoreError(result.error, "DataValidationFailed") &&
            result.error.payload.label === openSync.label
          )
            return new Response(null, { status: 400 });
          if (isError(result.error, "StreamDenied")) return new Response(null, { status: 403 });
        }
        return new Response(readResult(result), {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
          },
        });
      },
    };
  },
});
