import { namespace, operation } from "@tinker/core";
import type { Observe } from "@tinker/core";
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
  /** The span fields OTLP needs: a Core span fits, and so does one read back from a worker line. */
  type SpanFields = Pick<
    Observe.Span,
    | "traceId"
    | "spanId"
    | "parentSpanId"
    | "sampled"
    | "name"
    | "kind"
    | "start"
    | "end"
    | "status"
    | "error"
    | "attributes"
    | "events"
  >;
  /**
   * One line from the request thread to the telemetry worker: raw fields, no OTLP shape.
   * `encoded` 1 means every attribute value is already `encodeValue` output.
   */
  type Wire =
    | [
        tag: "s",
        side: Side,
        time: number,
        encoded: 0 | 1,
        traceId: string,
        spanId: string,
        parentSpanId: string | null,
        sampled: boolean,
        name: string,
        kind: Observe.Kind,
        start: number,
        end: number | null,
        status: "ok" | "failed" | null,
        error: string | null,
        attributes: { [key: string]: unknown },
        events: Observe.Event[],
      ]
    | [
        tag: "l",
        side: Side,
        encoded: 0 | 1,
        level: number,
        time: number,
        traceId: string | null,
        spanId: string | null,
        message: string,
        attributes: { [key: string]: unknown },
      ]
    | [tag: "b", batch: Batch];
}

/**
 * The exporter's own bucket: work run in it makes no span or log line (ADR 0119).
 * Telemetry encodes inside Core's export callback; a traced encode would export itself again.
 */
export const quiet = namespace({ observe: false });

/** Bounds one attribute value to its wire string; a bigint or a cycle still encodes. */
export const encodeValue = operation({
  label: "telemetry.encodeValue",
  input: (raw: unknown) => raw,
  run: (_deps, ctx): string => {
    const value = ctx.input;
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
  },
});

/**
 * Shapes one span into its OTLP body; the in-process observer and the worker drain share it.
 * `encoded` comes from a worker line's flag: its values are already `encodeValue` output.
 */
export const spanBody = operation({
  label: "telemetry.spanBody",
  depends: { encodeValue },
  input: (raw: unknown) => raw as { span: Telemetry.SpanFields; encoded: boolean },
  run: ({ encodeValue }, ctx): Telemetry.SpanBody => {
    const { span, encoded } = ctx.input;
    const [startTimeUnixNano, endTimeUnixNano] = [span.start, span.end ?? span.start].map(
      (time) => {
        const millis = Math.trunc(time);
        return millis === 0 ? "0" : `${millis}000000`;
      },
    );

    const attributes = Object.entries(span.attributes)
      .slice(0, 31)
      .map(([key, value]) => ({
        key: key.slice(0, 256),
        value: { stringValue: encoded ? (value as string) : encodeValue.run({ input: value }) },
      }));
    attributes.push({ key: "tinker.kind", value: { stringValue: span.kind } });

    return {
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      flags: span.sampled ? 1 : 0,
      name: span.name.slice(0, 256),
      kind: 1,
      startTimeUnixNano: startTimeUnixNano!,
      endTimeUnixNano: endTimeUnixNano!,
      attributes,
      events: span.events.slice(0, 32).map((event) => {
        const millis = Math.trunc(event.time);
        return {
          name: event.name.slice(0, 256),
          timeUnixNano: millis === 0 ? "0" : `${millis}000000`,
          attributes: Object.entries(event.attributes)
            .slice(0, 31)
            .map(([key, value]) => ({
              key: key.slice(0, 256),
              value: {
                stringValue: encoded ? (value as string) : encodeValue.run({ input: value }),
              },
            })),
        };
      }),
      status:
        span.status === "failed"
          ? { code: 2, message: String(span.error).slice(0, 2048) }
          : { code: 1 },
    };
  },
});
