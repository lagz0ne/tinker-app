import type { Many, Observe, Resource, Scope, Tag } from "@tinker/core";
import { z } from "zod";

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
const logRecord = z.strictObject({
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
  type Health = { pending: number; dropped: number } & (
    | { kind: "idle" | "queued" | "sending" | "closed" }
    | { kind: "failed"; failure: string }
  );
  type Settings = { side: Side; service: string } & (
    | { side: "server" | "ssr"; traces: string; logs: string }
    | { side: "browser" }
  );
  type Delivery = { traces: boolean; logs: boolean };
  /**
   * What the telemetry part gives the router entry (ADR 0106). The entry makes a telemetry root
   * from `extensions` and `tags`, so the app root's own work is never observed there.
   */
  type Part = {
    readonly extensions: Many<Scope.Extension<unknown>>;
    readonly tags: Tag.Bindings;
    /** The app root's `observe` option, read from the telemetry root. */
    readonly observe: Resource.Handle<Observe.Config | undefined>;
  };
  /** What the telemetry part gives the server entry: also the app root's tags. */
  type ServerPart = Part & { readonly appTags: Resource.Handle<Tag.Bindings> };
}

/** Core attributes may contain bigint or cycles; one bad field must not lose its record.
 * @param value - From a span or log attribute; why: bound and safely encode its wire value.
 */
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
