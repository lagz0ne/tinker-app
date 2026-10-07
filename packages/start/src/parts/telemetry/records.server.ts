import { z } from "zod";

const attribute = z.strictObject({
  key: z.string().max(256),
  value: z.strictObject({ stringValue: z.string().max(2048) }),
});
export const span = z.strictObject({
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
