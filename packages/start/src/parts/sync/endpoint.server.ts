import { resource } from "@tinker/core";
import { ZodError } from "zod";
import { readResult } from "../../backend/result.server.ts";
import { streamCursor, streamRequest } from "./protocol.ts";
import { openSync } from "./stream.server.ts";

/**
 * The reply of `GET /api/sync` (ADR 0103). The cursor comes from `Last-Event-ID` (a reconnect),
 * else `?cursor=`, else the start; a cursor that does not read is a 400, another account's is a
 * 403. The stream answers with Server-Sent Events.
 */
export const syncEndpoint = resource({
  label: "sync.endpoint",
  target: "session",
  depends: { open: openSync.controller },
  factory: ({ open }) => ({
    async answer(request: Request): Promise<Response> {
      let cursor;
      try {
        const { search, lastEventId } = streamRequest.parse({
          search: new URL(request.url).search,
          lastEventId: request.headers.get("Last-Event-ID"),
        });
        const supplied = lastEventId || new URLSearchParams(search).get("cursor");
        cursor = streamCursor.parse(supplied ? JSON.parse(supplied) : { public: 0, private: null });
      } catch (error) {
        if (!(error instanceof SyntaxError) && !(error instanceof ZodError)) throw error;
        return new Response(null, { status: 400 });
      }
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
  }),
});
