import type pino from "pino";
import { createIsomorphicFn } from "@tanstack/react-start";
import { data, extension, operation, resource, tag } from "@tinker/core";
import type { Observe, Clock } from "@tinker/core";
import { encodeSpan, encodeValue, logRecord, telemetryBatch } from "./records.ts";
import type { Telemetry } from "./records.ts";
import { TelemetryQueue } from "./queue.ts";
export type { Telemetry } from "./records.ts";

export const history = data<Telemetry.Row[]>({ label: "telemetry.history", initial: [] });
export const exportHealth = data<Telemetry.Health>({
  label: "telemetry.exportHealth",
  initial: { kind: "idle", pending: 0, dropped: 0 },
});
export const telemetrySettings = tag<Telemetry.Settings>({
  label: "telemetry.settings",
});
const queue = resource({
  label: "telemetry.queue",
  target: "scope",
  depends: { settings: telemetrySettings.required, health: exportHealth.controller },
  factory: ({ settings, health }, ctx) => {
    const owned = new TelemetryQueue(settings, ctx.clock, health);
    ctx.defer(() => owned.close());
    return owned;
  },
});
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

const createWriter = createIsomorphicFn()
  .server(
    async (
      settings: Telemetry.Settings,
      clock: Clock.Handle,
      accept: (record: Telemetry.Log) => void,
    ): Promise<pino.Logger> => {
      const { default: pino } = await import("pino");
      const local = pino.destination({ dest: 1, sync: true });
      return pino(
        {
          level: settings.level,
          base: { service: settings.service, side: settings.side },
          timestamp: () => `,"time":${clock.currentTimeMillis()}`,
        },
        {
          write(line: string) {
            local.write(line);
            accept(logRecord.parse(JSON.parse(line)));
          },
        },
      );
    },
  )
  .client(
    async (
      settings: Telemetry.Settings,
      _clock: Clock.Handle,
      accept: (record: Telemetry.Log) => void,
    ): Promise<pino.Logger> => {
      const { default: pino } = await import("pino");
      const local = pino({ level: settings.level, browser: { asObject: true } });
      return pino({
        level: settings.level,
        base: { service: settings.service, side: settings.side },
        browser: {
          asObject: true,
          write(raw: unknown) {
            const record = logRecord.parse(raw);
            accept(record);
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
    },
  );
const logWriter = resource({
  label: "telemetry.writer",
  depends: { settings: telemetrySettings.required, queue },
  factory: ({ settings, queue }, ctx) =>
    createWriter(settings, ctx.clock, (record) => queue.ingest({ traces: [], logs: [record] })),
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
      queue.ingest({ traces: [encodeSpan(span, settings.side)], logs: [] });
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
