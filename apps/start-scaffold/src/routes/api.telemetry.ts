import { createFileRoute } from "@tanstack/react-router";

import { startRequests } from "~/components/requests";
import { readResult } from "~/components/requests/index.server";
import {
  receiveTelemetry,
  telemetryBody,
  telemetryOrigin,
} from "~/components/telemetry/index.server";

const previewOrigin = /^http:(\/\/[^/:]+\.preview\.tini\.works)$/;

/** The copied route owns HTTP checks and replies; the component owns bounded batch reads. */
export const Route = createFileRoute("/api/telemetry")({
  server: {
    middleware: [startRequests.middleware],
    handlers: {
      POST: async ({ request, context }) => {
        const origin = context.session.resolve(telemetryOrigin);
        const expected =
          origin === null
            ? new URL(request.url).origin.replace(previewOrigin, "https:$1")
            : new URL(origin).origin;
        const refused = [
          [request.headers.get("origin") !== expected, 403],
          [request.headers.get("content-type")?.split(";")[0] !== "application/json", 415],
          [Number(request.headers.get("content-length")) > 65_536, 413],
        ].find(([refused]) => refused);
        if (refused) return new Response(null, { status: Number(refused[1]) });

        const body = request.body;
        if (body === null) return new Response(null, { status: 400 });
        const batch = await context.session.resolve(telemetryBody).read(body);
        if (typeof batch === "number") return new Response(null, { status: batch });

        const result = await context.session.settle(receiveTelemetry, {
          input: batch,
          signal: request.signal,
        });
        if (result.status === "failed" && Object(result.error).kind === "Cancelled") {
          return new Response(null, { status: 503 });
        }
        readResult(result);
        return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
      },
    },
  },
});
