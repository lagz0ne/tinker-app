import { extension, LEVELS, operation, resource } from "@tinker/core";
import type { Observe } from "@tinker/core";
import { encodeValue, telemetryBatch } from "./records.ts";
import type { Telemetry } from "./records.ts";
import { queue } from "./queue.ts";
import { telemetrySettings } from "./settings.ts";

/** Transfers the records to the telemetry root; callers must not edit them afterward. */
export const ingestTelemetry = operation({
  label: "telemetry.ingest",
  depends: { queue },
  input: telemetryBatch,
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
      await event.resolve(queue).close();
      return event.next();
    },
  },
});

/**
 * The app root's observe option. Each finished span and each log line becomes a record in the
 * telemetry root's queue, and a line on the local console: JSON on the server, an object in the
 * browser. Core drops lines below info.
 */
export const observer = resource({
  label: "telemetry.observer",
  depends: { queue, settings: telemetrySettings },
  factory: ({ queue, settings }, ctx): Observe.Config => {
    const { service, side } = settings;
    const write = (record: Telemetry.Log) => {
      queue.ingest({ traces: [], logs: [record] });
      if (side !== "browser") process.stdout.write(`${JSON.stringify(record)}\n`);
      else if (record.level >= LEVELS.error) console.error(record);
      else if (record.level >= LEVELS.warn) console.warn(record);
      else console.info(record);
    };
    return {
      history: 80,
      level: LEVELS.info,
      export(span) {
        queue.ingest({
          traces: [
            {
              side,
              traceId: span.traceId,
              spanId: span.spanId,
              parentSpanId: span.parentSpanId,
              flags: span.sampled ? 1 : 0,
              name: span.name.slice(0, 256),
              kind: 1,
              startTimeUnixNano: (BigInt(Math.trunc(span.start)) * 1_000_000n).toString(),
              endTimeUnixNano: (BigInt(Math.trunc(span.end ?? span.start)) * 1_000_000n).toString(),
              attributes: [
                ...Object.entries(span.attributes)
                  .slice(0, 31)
                  .map(([key, value]) => ({
                    key: key.slice(0, 256),
                    value: { stringValue: encodeValue(value) },
                  })),
                { key: "tinker.kind", value: { stringValue: span.kind } },
              ],
              events: span.events.slice(0, 32).map((event) => ({
                name: event.name.slice(0, 256),
                timeUnixNano: (BigInt(Math.trunc(event.time)) * 1_000_000n).toString(),
                attributes: Object.entries(event.attributes)
                  .slice(0, 31)
                  .map(([key, value]) => ({
                    key: key.slice(0, 256),
                    value: { stringValue: encodeValue(value) },
                  })),
              })),
              status:
                span.status === "failed"
                  ? { code: 2, message: String(span.error).slice(0, 2048) }
                  : { code: 1 },
            },
          ],
          logs: [],
        });
        write({
          level: LEVELS.info,
          time: ctx.clock.currentTimeMillis(),
          service,
          side,
          traceId: span.traceId,
          spanId: span.spanId,
          msg: "core.span",
        });
      },
      log(entry) {
        write({
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
        });
      },
    };
  },
});
