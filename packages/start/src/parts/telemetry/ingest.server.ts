import type { Scope } from "@tinker/core";
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
export const browserTelemetry = tag<(batch: Telemetry.Batch) => void>({
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
  run: ({ ingest, backendStop, requestStop }, ctx) => {
    if (backendStop.aborted || requestStop.aborted || ctx.signal.aborted) raise("Cancelled", {});
    ingest(ctx.input);
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
    browserTelemetry((batch) => {
      for (const record of batch.logs) record.service = settings.service;
      ingest.run({ input: batch });
    }),
  ],
});

const browserBatch = telemetryBatch.refine(
  (batch) =>
    batch.logs.every((log) => log.side === "browser") &&
    batch.traces.every((span) => span.side === "browser"),
);

const previewOrigin = /^http:(\/\/[^/:]+\.preview\.tini\.works)$/;
const decoder = new TextDecoder("utf-8", { fatal: true });

/** A preview host's proxy ends TLS, so its request origin is HTTPS. */
function refused(request: Request, origin: string | null) {
  const expected =
    origin === null
      ? new URL(request.url).origin.replace(previewOrigin, "https:$1")
      : new URL(origin).origin;
  if (request.headers.get("origin") !== expected) return 403;
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") return 415;
  if (Number(request.headers.get("content-length")) > 65_536) return 413;
}

/** Only a complete UTF-8 browser batch crosses the request boundary. */
function parse(chunks: Uint8Array<ArrayBuffer>[], length: number) {
  try {
    let bytes: Uint8Array<ArrayBuffer>;
    if (chunks.length === 1) bytes = chunks.at(0)!;
    else {
      bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
    return browserBatch.parse(JSON.parse(decoder.decode(bytes)));
  } catch {
    return 400;
  }
}

async function readBatch(
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
  bodyOwner: ReturnType<typeof requestBody.factory>,
): Promise<Telemetry.Batch | number> {
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
    return bodyOwner.signal.aborted ? 503 : parse(chunks, bytes);
  } finally {
    await bodyOwner.release();
  }
}

class TelemetryEndpoint {
  private receive: Scope.OperationController<void, Telemetry.Batch>;
  private origin: string | null;
  private bodyOwner: ReturnType<typeof requestBody.factory>;

  constructor(
    receive: Scope.OperationController<void, Telemetry.Batch>,
    origin: string | null,
    bodyOwner: ReturnType<typeof requestBody.factory>,
  ) {
    this.receive = receive;
    this.origin = origin;
    this.bodyOwner = bodyOwner;
  }

  async answer(request: Request): Promise<Response> {
    const body = request.body;
    const read =
      refused(request, this.origin) ??
      (body === null ? 400 : await readBatch(body, this.bodyOwner));
    if (typeof read === "number") return new Response(null, { status: read });
    const result = await this.receive.settle({ input: read, signal: request.signal });
    if (result.status === "failed" && Object(result.error).kind === "Cancelled")
      return new Response(null, { status: 503 });
    readResult(result);
    return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
  }
}

/** A same-origin JSON post, capped at 64 KiB, read under the request's own owner (ADR 0103). */
export const telemetryEndpoint = resource({
  label: "telemetry.endpoint",
  target: "session",
  depends: {
    receive: receiveTelemetry.controller,
    origin: telemetryOrigin,
    bodyOwner: requestBody,
  },
  factory: ({ receive, origin, bodyOwner }) => new TelemetryEndpoint(receive, origin, bodyOwner),
});
