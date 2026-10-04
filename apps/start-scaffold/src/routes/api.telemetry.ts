import { createFileRoute } from "@tanstack/react-router";
import { startRequests } from "../scaffold/start.ts";
import { receiveTelemetry, telemetryOrigin } from "../scaffold/telemetry/ingest.server.ts";
import { telemetryBatch } from "../scaffold/telemetry/records.ts";
import type { Telemetry } from "../scaffold/telemetry/records.ts";
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
        const bodyStream = request.body;
        const [contentType] = String(request.headers.get("content-type")).split(";");
        const rejected = [
          { failed: request.headers.get("origin") !== expected, status: 403 },
          { failed: contentType !== "application/json", status: 415 },
          { failed: Number(request.headers.get("content-length")) > 65_536, status: 413 },
          { failed: bodyStream === null, status: 400 },
        ].find(({ failed }) => failed);
        if (rejected) return new Response(null, { status: rejected.status });
        const bodyOwner = context.session.resolve(requestBody);
        const signal = bodyOwner.signal;
        const reader = bodyOwner.open(bodyStream!);
        let batch: Telemetry.Batch;
        try {
          let bytes = 0;
          const chunks: Uint8Array<ArrayBuffer>[] = [];
          for (let next = await reader.read(); !next.done; next = await reader.read()) {
            bytes += next.value.byteLength;
            if (bytes > 65_536) {
              await reader.cancel();
              return new Response(null, { status: 413 });
            }
            chunks.push(next.value);
          }
          if (signal.aborted) return new Response(null, { status: 503 });
          const body = await new Blob(chunks).arrayBuffer();
          try {
            batch = browserBatch.parse(
              JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
            );
          } catch {
            return new Response(null, { status: 400 });
          }
        } finally {
          await bodyOwner.release();
        }
        const result = await context.session.settle(receiveTelemetry, {
          input: batch,
          signal: context.signal,
        });
        const { error } = { error: undefined, ...result };
        if (isError(error, "Cancelled")) return new Response(null, { status: 503 });
        readResult(result);
        return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
      },
    },
  },
});
