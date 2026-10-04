import { createFileRoute } from "@tanstack/react-router";
import { startRequests } from "../scaffold/start.ts";
import { receiveTelemetry, telemetryOrigin } from "../scaffold/telemetry/ingest.server.ts";
import { telemetryBatch } from "../scaffold/telemetry/records.ts";
import { requestBody } from "../scaffold/backend/request-body.server.ts";
import { readResult } from "../scaffold/backend/result.server.ts";
import { isError } from "../errors.ts";

const browserBatch = telemetryBatch.refine(
  (batch) =>
    batch.logs.every((log) => log.side === "browser") &&
    batch.traces.every((span) => span.side === "browser"),
);

export const Route = createFileRoute("/api/telemetry")({
  server: {
    middleware: [startRequests.middleware],
    handlers: {
      POST: async ({ request, context }) => {
        const origin = context.session.resolve(telemetryOrigin);
        const expected =
          origin === null
            ? new URL(request.url).origin.replace(
                /^http:(\/\/[^/:]+\.preview\.tini\.works)$/,
                "https:$1",
              )
            : new URL(origin).origin;
        if (request.headers.get("origin") !== expected) return new Response(null, { status: 403 });
        const [contentType] = String(request.headers.get("content-type")).split(";");
        if (contentType !== "application/json") return new Response(null, { status: 415 });
        if (Number(request.headers.get("content-length")) > 65_536)
          return new Response(null, { status: 413 });
        const batch = await Promise.resolve().then(async () => {
          if (request.body === null) return new Response(null, { status: 400 });
          const bodyOwner = context.session.resolve(requestBody);
          const signal = bodyOwner.signal;
          const reader = bodyOwner.open(request.body);
          try {
            let bytes = 0;
            const chunks: Uint8Array<ArrayBuffer>[] = [];
            while (!signal.aborted) {
              const next = await reader.read();
              if (next.done) break;
              bytes += next.value.byteLength;
              if (bytes > 65_536) {
                await reader.cancel();
                return new Response(null, { status: 413 });
              }
              chunks.push(next.value);
            }
            if (signal.aborted) return new Response(null, { status: 503 });
            const body = await new Blob(chunks).arrayBuffer();
            return Promise.resolve().then(() => {
              try {
                const parsed = browserBatch.safeParse(
                  JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
                );
                return parsed.success ? parsed.data : new Response(null, { status: 400 });
              } catch {
                return new Response(null, { status: 400 });
              }
            });
          } finally {
            await bodyOwner.release();
          }
        });
        if (batch instanceof Response) return batch;
        const result = await context.session.settle(receiveTelemetry, {
          input: batch,
          signal: context.signal,
        });
        if (result.status === "failed" && isError(result.error, "Cancelled"))
          return new Response(null, { status: 503 });
        readResult(result);
        return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
      },
    },
  },
});
