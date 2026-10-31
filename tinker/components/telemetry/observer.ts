import { extension, LEVELS, operation, resource } from "@tinker/core";
import type { Observe } from "@tinker/core";

import { logConsole } from "./console";
import { queue } from "./queue";
import { encodeValue, quiet, spanBody } from "./records";
import type { Telemetry } from "./records";
import {
  logLevel,
  spanHistory,
  telemetryService,
  telemetrySide,
  tracesUrl,
  logsUrl,
} from "./settings";

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
      const side = event.resolve(telemetrySide);
      event.resolve(telemetryService);
      if (side !== "browser") {
        event.resolve(tracesUrl);
        event.resolve(logsUrl);
      }

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
    encodeValue,
    spanBody,
  },
  factory: (
    { queue, service, side, level, history, show, encodeValue, spanBody },
    ctx,
  ): Observe.Config => ({
    history,
    level,
    export(span) {
      queue.add("trace", side, spanBody.run({ input: { span, encoded: false }, ns: quiet }));

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
            encodeValue.run({ input: value, ns: quiet }),
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
