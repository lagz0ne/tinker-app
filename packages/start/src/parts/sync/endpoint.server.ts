import { resource } from "@tinker/core";
import { readResult } from "../../backend/result.server";
import { streamCursor, streamRequest } from "./protocol";
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
    const readCursor = (request: Request) => {
      try {
        const read = streamRequest.safeParse({
          search: new URL(request.url).search,
          lastEventId: request.headers.get("Last-Event-ID"),
        });
        if (!read.success) return;
        const { search, lastEventId } = read.data;
        const supplied = lastEventId || new URLSearchParams(search).get("cursor");
        const parsed = streamCursor.safeParse(
          supplied ? JSON.parse(supplied) : { public: 0, private: null },
        );
        return parsed.success ? parsed.data : undefined;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    };
    return {
      async answer(request: Request): Promise<Response> {
        const cursor = readCursor(request);
        if (!cursor) return new Response(null, { status: 400 });
        /** requestStop already binds cancellation; a call signal would close a shorter child session. */
        const result = await open.settle({ input: { cursor } });
        if (result.status === "failed" && Object(result.error).kind === "StreamDenied")
          return new Response(null, { status: 403 });
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
