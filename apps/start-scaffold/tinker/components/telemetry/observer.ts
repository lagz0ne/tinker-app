import { extension, LEVELS, operation, resource } from "@tinker/core";
import type { Observe } from "@tinker/core";

import { logConsole } from "./console";
import { queue } from "./queue";
import { encodeValue } from "./records";
import type { Telemetry } from "./records";
import { logLevel, spanHistory, telemetryService, telemetrySide } from "./settings";

/**
 * Transfers trusted records to the telemetry root; callers must not edit them afterward.
 * The server route validates outside data before this operation receives it.
 */
export const ingestTelemetry = operation({
  label: "telemetry.ingest",
  depends: { queue },
  input: (raw: unknown) => raw as Telemetry.Batch,
  run: ({ queue }, ctx) => queue.ingest(ctx.input),
});

export const flushTelemetry = operation({
  label: "telemetry.export",
  depends: { queue },
  run: ({ queue }) => queue.flush(),
});

/** On the telemetry root: the queue's timer starts with the root, and its close sends what is left. */
export const telemetryExport = extension({
  label: "telemetry",
  hooks: {
    async start(event) {
      const owned = event.resolve(queue);
      const flush = event.controller(flushTelemetry);
      owned.start(flush.run.bind(flush));
      await event.next();
    },
    async close(event) {
      await event.resolve(queue).close(true);
      return event.next();
    },
  },
});

/** Each native observer callback owns its queue and console work. */
export const observer = resource({
  label: "telemetry.observer",
  depends: {
    queue,
    service: telemetryService,
    side: telemetrySide,
    level: logLevel,
    history: spanHistory,
    show: logConsole,
  },
  factory: ({ queue, service, side, level, history, show }, ctx): Observe.Config => ({
    history,
    level,
    export(span) {
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
          value: { stringValue: encodeValue(value) },
        }));
      attributes.push({ key: "tinker.kind", value: { stringValue: span.kind } });
      queue.add("trace", side, {
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
                value: { stringValue: encodeValue(value) },
              })),
          };
        }),
        status:
          span.status === "failed"
            ? { code: 2, message: String(span.error).slice(0, 2048) }
            : { code: 1 },
      });

      const record: Telemetry.Log = {
        level: LEVELS.info,
        time: ctx.clock.currentTimeMillis(),
        service,
        side,
        traceId: span.traceId,
        spanId: span.spanId,
        attributes: undefined,
        msg: "core.span",
      };
      const encoded = queue.add("log", side, record);
      if (side !== "browser") queue.writeConsole(encoded, record);
      else show?.info(record);
      queue.publishQueued();
    },
    log(entry) {
      const record: Telemetry.Log = {
        level: entry.level,
        time: entry.time,
        service,
        side,
        traceId: entry.span?.traceId,
        spanId: entry.span?.spanId,
        attributes: Object.fromEntries(
          Object.entries(entry.attributes).map(([key, value]) => [
            key.slice(0, 256),
            encodeValue(value),
          ]),
        ),
        msg: entry.message.slice(0, 2048),
      };
      const encoded = queue.add("log", side, record);
      if (side !== "browser") queue.writeConsole(encoded, record);
      else if (!show) {
        /* No console binding on this owner. */
      } else if (record.level >= LEVELS.error) show.error(record);
      else if (record.level >= LEVELS.warn) show.warn(record);
      else show.info(record);
      queue.publishQueued();
    },
  }),
});
