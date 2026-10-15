import type { z } from "zod";

import type { span, logRecord, telemetryBatch } from "./records.server";

export declare namespace Telemetry {
  type Span = z.infer<typeof span>;
  type Log = z.infer<typeof logRecord>;
  type Batch = z.infer<typeof telemetryBatch>;
  type Side = Log["side"];
  type Health = { pending: number; dropped: number } & (
    | { kind: "idle" | "queued" | "sending" }
    | { kind: "failed"; failure: string }
  );
  type SpanBody = Omit<Span, "side">;
  /** Retained JSON is owned by the queue until storage accepts it. */
  type Record = { kind: "trace" | "log"; side: Side; json: string; bytes: number };
  type Delivery = { traces: boolean; logs: boolean };
}

/** Core attributes may contain bigint or cycles; one bad field must not lose its record.
 * @param value - From a span or log attribute; why: bound and safely encode its wire value.
 */
export function encodeValue(value: unknown): string {
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return JSON.stringify(value).slice(0, 2048);
    case "bigint":
      return value.toString().slice(0, 2048);
    case "undefined":
      return "undefined";
  }
  try {
    return (
      JSON.stringify(value, (_key, entry) =>
        typeof entry === "bigint" ? entry.toString() : entry,
      ) ?? "undefined"
    ).slice(0, 2048);
  } catch {
    return "[Unserializable]";
  }
}
