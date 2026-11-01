import type { Observe } from "@tinker/core";
import { z } from "zod";

/**
 * A W3C `traceparent` header, version 00, read as Core's remote parent (ADR 0076). Lowercase
 * hex only; an all-zero trace or span id fails. A request with no valid header starts a fresh
 * trace: read it with `safeParse(...).data ?? null`, never let it fail the request.
 */
export const traceparent = z
  .string()
  .regex(/^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/)
  .transform((header): Observe.Trace => {
    const [, traceId = "", parentSpanId = "", flags = ""] = header.split("-");
    return { traceId, parentSpanId, sampled: (Number.parseInt(flags, 16) & 1) === 1 };
  });
