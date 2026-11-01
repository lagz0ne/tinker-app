import { operation, resource, tag } from "@tinker/core";
import { z } from "zod";

import type { Errors } from "~/components/errors";
import { requestStop } from "~/components/requests";
import { requestBody, routes } from "~/components/requests/index.server";

import { ingestTelemetry } from "./observer";
import type { Telemetry } from "./records";
import { telemetryBatch } from "./records.server";
import { telemetryService } from "./settings";

/**
 * The public origin tab batches must come from; unset, the request URL's own origin. Checked
 * once, when it is bound: anything but an http(s) URL raises `DataValidationFailed` naming
 * `telemetry.origin`, since any other URL has the origin "null", which a sandboxed page sends.
 */
export const telemetryOrigin = tag<string | null>({
  label: "telemetry.origin",
  default: null,
  parse: (raw) => {
    if (raw === null) return null;
    const url = typeof raw === "string" ? URL.parse(raw) : null;
    if (!url || !/^https?:$/.test(url.protocol)) throw new TypeError("not an http(s) URL");
    return url.origin;
  },
});

export const browserIngest = resource({
  label: "telemetry.browserIngest",
  depends: { ingest: ingestTelemetry.controller, service: telemetryService },
  factory: ({ ingest, service }) => ({
    ingest(this: void, batch: Telemetry.Batch) {
      for (const record of batch.logs) record.service = service;
      ingest.run({ input: batch });
    },
  }),
});

const browserBatch = telemetryBatch.refine(
  (batch) =>
    batch.logs.every((log) => log.side === "browser") &&
    batch.traces.every((span) => span.side === "browser"),
);

/** The request owns its reader and caps retained bytes before JSON or UTF-8 work. */
export const telemetryBody = resource({
  label: "telemetry.body",
  target: "session",
  depends: { bodyOwner: requestBody },
  factory: ({ bodyOwner }) => {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return {
      async read(body: ReadableStream<Uint8Array<ArrayBuffer>>): Promise<Telemetry.Batch | number> {
        const reader = bodyOwner.open(body);
        try {
          let length = 0;
          const chunks: Uint8Array<ArrayBuffer>[] = [];
          for (let next = await reader.read(); !next.done; next = await reader.read()) {
            length += next.value.byteLength;
            if (length > 65_536) {
              await reader.cancel();
              return 413;
            }
            chunks.push(next.value);
          }
          if (bodyOwner.signal.aborted) return 503;

          const bytes = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }

          try {
            return browserBatch.parse(JSON.parse(decoder.decode(bytes)));
          } catch {
            return 400;
          }
        } finally {
          await bodyOwner.release();
        }
      },
    };
  },
});

const previewOrigin = /^http:(\/\/[^/:]+\.preview\.tini\.works)$/;

/** One browser batch, posted to this root. The route owns the HTTP checks and replies. */
export const telemetryRoute = operation({
  label: "telemetry.route",
  input: z.object({}),
  depends: {
    request: routes.request.required,
    stop: requestStop.required,
    origin: telemetryOrigin,
    body: telemetryBody,
    sink: browserIngest,
  },
  run: async ({ request, stop, origin, body, sink }, ctx) => {
    const raise: Errors.Raise = ctx.raise;

    const expected = origin ?? new URL(request.url).origin.replace(previewOrigin, "https:$1");
    const refused = [
      [request.headers.get("origin") !== expected, 403],
      [String(request.headers.get("content-type")).split(";")[0] !== "application/json", 415],
      [Number(request.headers.get("content-length")) > 65_536, 413],
    ].find(([refused]) => refused);
    if (refused) return new Response(null, { status: Number(refused[1]) });

    if (request.body === null) return new Response(null, { status: 400 });
    const batch = await body.read(request.body);
    if (typeof batch === "number") return new Response(null, { status: batch });
    if (stop.aborted || ctx.signal.aborted) return raise("Cancelled", {});

    sink.ingest(batch);
    return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
  },
});
