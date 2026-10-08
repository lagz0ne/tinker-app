import { operation, resource, tag } from "@tinker/core";
import { backendStop, requestStop } from "../../backend/lifetime";
import { requestBody } from "../../backend/request-body.server";
import { readResult } from "../../backend/result.server";
import { raise } from "../../errors";
import { ingestTelemetry } from "./observer";
import { telemetryBatch } from "./records.server";
import type { Telemetry } from "./records";
import { telemetrySettings } from "./settings";

/** Borrowed from the telemetry root. Requests neither create nor close that owner. */
export const browserTelemetry = tag<(batch: Telemetry.Batch) => Promise<void>>({
  label: "telemetry.browserIngest",
});

/** A live host binds its public origin; null reads it from the request. */
export const telemetryOrigin = tag<string | null>({ label: "telemetry.origin", default: null });

export const receiveTelemetry = operation({
  label: "telemetry.receive",
  depends: {
    ingest: browserTelemetry.required,
    backendStop: backendStop.required,
    requestStop: requestStop.required,
  },
  input: telemetryBatch,
  run: async ({ ingest, backendStop, requestStop }, ctx) => {
    if (backendStop.aborted || requestStop.aborted || ctx.signal.aborted) raise("Cancelled", {});
    await ingest(ctx.input);
  },
});

/**
 * The app root's tags, built on the telemetry root: a browser batch joins this root's queue
 * under the server's own service name.
 */
export const browserIngest = resource({
  label: "telemetry.browserIngest",
  depends: { ingest: ingestTelemetry.controller, settings: telemetrySettings },
  factory: ({ ingest, settings }) => [
    browserTelemetry(async (batch) => {
      await Promise.resolve(
        ingest.run({
          input: {
            traces: batch.traces,
            logs: batch.logs.map((record) => ({ ...record, service: settings.service })),
          },
        }),
      );
    }),
  ],
});

const browserBatch = telemetryBatch.refine(
  (batch) =>
    batch.logs.every((log) => log.side === "browser") &&
    batch.traces.every((span) => span.side === "browser"),
);

/**
 * The reply of `/api/telemetry` (ADR 0103): a same-origin JSON post of at most 64 KiB, holding
 * browser records only. Its body is read under the request's own owner.
 */
export const telemetryEndpoint = resource({
  label: "telemetry.endpoint",
  target: "session",
  depends: {
    receive: receiveTelemetry.controller,
    origin: telemetryOrigin,
    bodyOwner: requestBody,
  },
  factory: ({ receive, origin, bodyOwner }) => {
    /** The status of the first header check that fails; a preview host's proxy ends TLS. */
    const refused = (request: Request) => {
      const expected =
        origin === null
          ? new URL(request.url).origin.replace(
              /^http:(\/\/[^/:]+\.preview\.tini\.works)$/,
              "https:$1",
            )
          : new URL(origin).origin;
      const [contentType] = String(request.headers.get("content-type")).split(";");
      return [
        { failed: request.headers.get("origin") !== expected, status: 403 },
        { failed: contentType !== "application/json", status: 415 },
        { failed: Number(request.headers.get("content-length")) > 65_536, status: 413 },
      ].find(({ failed }) => failed)?.status;
    };
    /** Bytes that are not a UTF-8 JSON browser batch end the request with 400. */
    const parse = async (chunks: Uint8Array<ArrayBuffer>[]) => {
      try {
        const bytes = await new Blob(chunks).arrayBuffer();
        return browserBatch.parse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        );
      } catch {
        return 400;
      }
    };
    /** The body as a browser batch, or the status that ends the request. */
    const readBatch = async (
      body: ReadableStream<Uint8Array<ArrayBuffer>>,
    ): Promise<Telemetry.Batch | number> => {
      const reader = bodyOwner.open(body);
      try {
        let bytes = 0;
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        for (let next = await reader.read(); !next.done; next = await reader.read()) {
          bytes += next.value.byteLength;
          if (bytes > 65_536) {
            await reader.cancel();
            return 413;
          }
          chunks.push(next.value);
        }
        return bodyOwner.signal.aborted ? 503 : await parse(chunks);
      } finally {
        await bodyOwner.release();
      }
    };
    return {
      async answer(request: Request): Promise<Response> {
        const body = request.body;
        const read = refused(request) ?? (body === null ? 400 : await readBatch(body));
        if (typeof read === "number") return new Response(null, { status: read });
        const result = await receive.settle({ input: read, signal: request.signal });
        if (result.status === "failed" && Object(result.error).kind === "Cancelled")
          return new Response(null, { status: 503 });
        readResult(result);
        return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
      },
    };
  },
});
