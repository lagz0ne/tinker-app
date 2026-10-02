import { z } from "zod";
import { operation, tag } from "@tinker/core";
import { telemetryBatch } from "./records.ts";
import type { Telemetry } from "./records.ts";
import { backendStop, requestStop } from "../backend/lifetime.ts";

/** Borrowed from the backend telemetry root. Requests neither create nor close that owner. */
export const browserTelemetry = tag<(batch: Telemetry.Batch) => Promise<void>>({
  label: "telemetry.browserIngest",
});
/** A live host binds its public origin; null is the isolated localhost/HTTPS preview proof. */
export const telemetryOrigin = tag<string | null>({ label: "telemetry.origin" });
const browserBatch = telemetryBatch.refine(
  (batch) =>
    batch.logs.every((log) => log.side === "browser") &&
    batch.traces.every((span) => span.side === "browser"),
);
const readBrowserTelemetry = operation({
  label: "telemetry.readBody",
  depends: { backendStop: backendStop.required, requestStop: requestStop.required },
  input: z.instanceof(Request),
  run: async ({ backendStop, requestStop }, ctx) => {
    const signal = AbortSignal.any([backendStop, requestStop, ctx.signal]);
    if (ctx.input.body === null) return new Response(null, { status: 400 });
    const reader = ctx.input.body.getReader();
    let cancellation: Promise<void> | undefined;
    const cancel = () => {
      cancellation ??= reader.cancel();
    };
    signal.addEventListener("abort", cancel, { once: true });
    ctx.defer(async () => {
      signal.removeEventListener("abort", cancel);
      if (signal.aborted) cancel();
      await cancellation;
      reader.releaseLock();
    });
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
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
      return new Response(null, { status: 400 });
    }
    const parsed = browserBatch.safeParse(raw);
    return parsed.success ? parsed.data : new Response(null, { status: 400 });
  },
});
export const receiveTelemetry = operation({
  label: "telemetry.receive",
  depends: {
    ingest: browserTelemetry.required,
    read: readBrowserTelemetry,
    origin: telemetryOrigin.required,
  },
  input: z.instanceof(Request),
  run: async ({ ingest, read, origin }, ctx) => {
    const request = ctx.input;
    const expected =
      origin === null
        ? new URL(request.url).origin.replace(
            /^http:(\/\/[^/:]+\.preview\.tini\.works)$/,
            "https:$1",
          )
        : new URL(origin).origin;
    if (request.headers.get("origin") !== expected) return new Response(null, { status: 403 });
    const [contentType] = (request.headers.get("content-type") ?? "").split(";");
    if (contentType !== "application/json") return new Response(null, { status: 415 });
    if (Number(request.headers.get("content-length")) > 65_536)
      return new Response(null, { status: 413 });
    const batch = await read.run({ input: request });
    if (batch instanceof Response) return batch;
    await ingest(batch);
    return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
  },
});
