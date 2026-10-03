import type pino from "pino";
import { createIsomorphicFn } from "@tanstack/react-start";
import { data, extension, operation, resource } from "@tinker/core";
import type { Observe } from "@tinker/core";
import { encodeFields, encodeNanos, encodeValue, logRecord, telemetryBatch } from "./records.ts";
import type { Telemetry } from "./records.ts";
import { queue } from "./queue.ts";
import { telemetrySettings } from "./state.ts";
export { telemetrySettings, exportHealth } from "./state.ts";
export type { Telemetry } from "./records.ts";

export const history = data<Telemetry.Row[]>({ label: "telemetry.history", initial: [] });
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
export const telemetry = extension({
  label: "telemetry",
  hooks: {
    async start(event) {
      const owned = event.resolve(queue);
      const flush = event.controller(flushTelemetry);
      owned.start(() => flush.run());
      await event.next();
    },
    async close(event) {
      event.resolve(queue).stopSchedule();
      return event.next();
    },
  },
});

const logWriter = resource({
  label: "telemetry.writer",
  depends: { settings: telemetrySettings.required, queue },
  factory: createIsomorphicFn()
    .server(async ({ settings, queue }, ctx): Promise<pino.Logger> => {
      const { default: pino } = await import("pino");
      const local = pino.destination({ dest: 1, sync: true });
      return pino(
        {
          level: settings.level,
          base: { service: settings.service, side: settings.side },
          timestamp: () => `,"time":${ctx.clock.currentTimeMillis()}`,
        },
        {
          write(line: string) {
            local.write(line);
            queue.ingest({ traces: [], logs: [logRecord.parse(JSON.parse(line))] });
          },
        },
      );
    })
    .client(async ({ settings, queue }): Promise<pino.Logger> => {
      const { default: pino } = await import("pino");
      const local = pino({ level: settings.level, browser: { asObject: true } });
      return pino({
        level: settings.level,
        base: { service: settings.service, side: settings.side },
        browser: {
          asObject: true,
          write(raw: unknown) {
            const record = logRecord.parse(raw);
            queue.ingest({ traces: [], logs: [record] });
            const write =
              record.level >= 50
                ? local.error
                : record.level >= 40
                  ? local.warn
                  : record.level >= 30
                    ? local.info
                    : local.debug;
            write.call(local, record);
          },
        },
      }).child({ service: settings.service, side: settings.side });
    }),
});
export const observer = resource({
  label: "telemetry.observer",
  depends: {
    rows: history.controller,
    writer: logWriter,
    queue,
    settings: telemetrySettings.required,
  },
  factory: async ({ rows, writer, queue, settings }): Promise<Observe.Config> => ({
    history: 80,
    export(span) {
      const row = {
        id: span.spanId,
        parentId: span.parentSpanId,
        traceId: span.traceId,
        name: span.name,
        kind: span.kind,
        status: span.status ?? "open",
        duration: (span.end ?? span.start) - span.start,
      };
      rows.update((old) => [...old.slice(-79), row]);
      queue.ingest({
        traces: [
          {
            side: settings.side,
            traceId: span.traceId,
            spanId: span.spanId,
            parentSpanId: span.parentSpanId,
            flags: span.sampled ? 1 : 0,
            name: span.name.slice(0, 256),
            kind: 1,
            startTimeUnixNano: encodeNanos(span.start),
            endTimeUnixNano: encodeNanos(span.end ?? span.start),
            attributes: [
              ...encodeFields(span.attributes),
              { key: "tinker.kind", value: { stringValue: span.kind } },
            ],
            events: span.events.slice(0, 32).map((event) => ({
              name: event.name.slice(0, 256),
              timeUnixNano: encodeNanos(event.time),
              attributes: encodeFields(event.attributes),
            })),
            status:
              span.status === "failed"
                ? { code: 2, message: String(span.error).slice(0, 2048) }
                : { code: 1 },
          },
        ],
        logs: [],
      });
      writer.info({ traceId: span.traceId, spanId: span.spanId }, "core.span");
    },
    log(entry) {
      const write: pino.LogFn =
        entry.level >= 50
          ? writer.error
          : entry.level >= 40
            ? writer.warn
            : entry.level >= 30
              ? writer.info
              : writer.debug;
      write.call(
        writer,
        {
          traceId: entry.span?.traceId,
          spanId: entry.span?.spanId,
          attributes: Object.fromEntries(
            Object.entries(entry.attributes).map(([key, value]) => [
              key.slice(0, 256),
              encodeValue(value),
            ]),
          ),
        },
        entry.message.slice(0, 2048),
      );
    },
  }),
});
