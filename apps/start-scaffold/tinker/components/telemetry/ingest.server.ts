import { operation, resource, tag } from "@tinker/core";

import type { Errors } from "~/components/errors";
import { backendStop, requestStop } from "~/components/requests";
import { requestBody } from "~/components/requests/index.server";

import { ingestTelemetry } from "./observer";
import type { Telemetry } from "./records";
import { telemetryBatch } from "./records.server";
import { telemetryService } from "./settings";

/** Borrowed from the telemetry root; requests never close that owner. */
export const browserTelemetry = tag<(batch: Telemetry.Batch) => void>({
  label: "telemetry.browserIngest",
});

export const telemetryOrigin = tag<string | null>({ label: "telemetry.origin", default: null });

export const receiveTelemetry = operation({
  label: "telemetry.receive",
  depends: {
    ingest: browserTelemetry.required,
    backendStop: backendStop.required,
    requestStop: requestStop.required,
  },
  input: telemetryBatch,
  run: ({ ingest, backendStop, requestStop }, ctx) => {
    if (backendStop.aborted || requestStop.aborted || ctx.signal.aborted) {
      return ctx.raise("Cancelled", {} satisfies Errors.Payloads["Cancelled"]);
    }
    ingest(ctx.input);
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
