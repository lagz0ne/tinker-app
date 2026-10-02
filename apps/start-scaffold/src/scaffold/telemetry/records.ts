import { z } from "zod";
import type { Observe } from "@tinker/core";

const attribute = z.strictObject({
  key: z.string().max(256),
  value: z.strictObject({ stringValue: z.string().max(2048) }),
});
const span = z.strictObject({
  side: z.enum(["server", "browser", "ssr"]),
  traceId: z
    .string()
    .regex(/^[0-9a-f]{32}$/)
    .refine((id) => /[1-9a-f]/.test(id)),
  spanId: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .refine((id) => /[1-9a-f]/.test(id)),
  parentSpanId: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .optional(),
  flags: z.literal(0).or(z.literal(1)),
  name: z.string().max(256),
  kind: z.literal(1),
  startTimeUnixNano: z.string().regex(/^\d{1,20}$/),
  endTimeUnixNano: z.string().regex(/^\d{1,20}$/),
  attributes: z.array(attribute).max(32),
  events: z
    .array(
      z.strictObject({
        name: z.string().max(256),
        timeUnixNano: z.string().regex(/^\d{1,20}$/),
        attributes: z.array(attribute).max(32),
      }),
    )
    .max(32),
  status: z.strictObject({
    code: z.literal(1).or(z.literal(2)),
    message: z.string().max(2048).optional(),
  }),
});
export const logRecord = z.strictObject({
  time: z.number().int().nonnegative(),
  level: z.number().int().min(10).max(60),
  msg: z.string().max(2048),
  service: z.string().min(1).max(128),
  side: z.enum(["server", "browser", "ssr"]),
  traceId: z
    .string()
    .regex(/^[0-9a-f]{32}$/)
    .optional(),
  spanId: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .optional(),
  attributes: z.record(z.string().max(256), z.string().max(2048)).optional(),
});
export const telemetryBatch = z
  .strictObject({ traces: z.array(span).max(64), logs: z.array(logRecord).max(64) })
  .refine((batch) => batch.traces.length + batch.logs.length <= 64);

export declare namespace Telemetry {
  type Span = z.infer<typeof span>;
  type Log = z.infer<typeof logRecord>;
  type Batch = z.infer<typeof telemetryBatch>;
  type Side = Log["side"];
  type Row = {
    id: string;
    parentId: string | undefined;
    traceId: string;
    name: string;
    kind: string;
    status: string;
    duration: number;
  };
  type Health = { pending: number; dropped: number } & (
    | { kind: "idle" | "queued" | "sending" | "closed" }
    | { kind: "failed"; failure: string }
  );
  type Settings = { side: Side; service: string; level: "info" | "debug" | "warn" | "error" } & (
    | { side: "server" | "ssr"; traces: string; logs: string }
    | { side: "browser" }
  );
  type Delivery = { traces: boolean; logs: boolean };
}

/** Core attributes may contain bigint or cycles; one bad field must not lose its record. */
export function encodeValue(value: unknown): string {
  if (typeof value === "bigint") return value.toString().slice(0, 2048);
  try {
    return (
      JSON.stringify(value, (_key, entry: unknown) =>
        typeof entry === "bigint" ? entry.toString() : entry,
      ) ?? "undefined"
    ).slice(0, 2048);
  } catch {
    return "[Unserializable]";
  }
}

/** Core owns the epoch clock and W3C identities; this only changes the wire units. */
export function encodeSpan(span: Observe.Span, side: Telemetry.Side): Telemetry.Span {
  const fields = (attributes: Record<string, unknown>) =>
    Object.entries(attributes)
      .slice(0, 31)
      .map(([key, value]) => ({
        key: key.slice(0, 256),
        value: { stringValue: encodeValue(value) },
      }));
  const nanos = (time: number) => (BigInt(Math.trunc(time)) * 1_000_000n).toString();
  return {
    side,
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    flags: span.sampled ? 1 : 0,
    name: span.name.slice(0, 256),
    kind: 1,
    startTimeUnixNano: nanos(span.start),
    endTimeUnixNano: nanos(span.end ?? span.start),
    attributes: [
      ...fields(span.attributes),
      { key: "tinker.kind", value: { stringValue: span.kind } },
    ],
    events: span.events.slice(0, 32).map((event) => ({
      name: event.name.slice(0, 256),
      timeUnixNano: nanos(event.time),
      attributes: fields(event.attributes),
    })),
    status:
      span.status === "failed"
        ? { code: 2, message: String(span.error).slice(0, 2048) }
        : { code: 1 },
  };
}
