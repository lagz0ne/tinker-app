import { resource } from "@tinker/core";
import type { Telemetry } from "./records.ts";
import { delivery } from "./delivery.ts";
import { telemetrySettings, exportHealth } from "./state.ts";

/** Retains failed records within count and byte bounds; this resource owns every promise. */
export const queue = resource({
  label: "telemetry.queue",
  target: "scope",
  depends: { settings: telemetrySettings.required, health: exportHealth.controller, delivery },
  factory: ({ settings, health, delivery }, ctx) => {
    let records: (
      | { kind: "trace"; value: Telemetry.Span }
      | { kind: "log"; value: Telemetry.Log }
    )[] = [];
    let queueBytes = 0;
    let dropped = 0;
    let timer: Promise<void> | undefined;
    let pending: Promise<void> | undefined;
    const stopTimer = new AbortController();
    const stopRequests = new AbortController();
    let state: "open" | "closing" | "closed" = "open";
    let publishing = true;
    let failed = false;
    const owned = {
      ingest(batch: Telemetry.Batch) {
        for (const value of batch.traces) owned.add({ kind: "trace", value });
        for (const value of batch.logs) owned.add({ kind: "log", value });
      },
      add(record: (typeof records)[number]) {
        const recordBytes = new TextEncoder().encode(JSON.stringify(record.value)).byteLength;
        if (
          state === "closed" ||
          recordBytes > 48_000 ||
          records.length >= 512 ||
          queueBytes + recordBytes > 1_048_576
        ) {
          dropped++;
        } else {
          records.push(record);
          queueBytes += recordBytes;
        }
        if (publishing) {
          const previous = health.get();
          owned.publish(
            previous.kind === "failed"
              ? { ...previous, pending: records.length, dropped: dropped }
              : {
                  kind: pending ? "sending" : "queued",
                  pending: records.length,
                  dropped: dropped,
                },
          );
        }
      },
      start(flush: () => Promise<void>) {
        if (settings.side !== "ssr") timer = owned.runTimer(flush);
      },
      async runTimer(flush: () => Promise<void>) {
        while (!stopTimer.signal.aborted) {
          try {
            await ctx.clock.sleep(1000, stopTimer.signal);
          } catch (error) {
            if (!stopTimer.signal.aborted) throw error;
            return;
          }
          if (!stopTimer.signal.aborted) await flush();
        }
      },
      stopSchedule() {
        publishing = false;
        stopTimer.abort();
      },
      publish(state: Telemetry.Health) {
        if (publishing) health.set(state);
      },
      flush(): Promise<void> {
        return (pending ??= owned.send().finally(() => {
          pending = undefined;
        }));
      },
      async abortAfter(target: AbortController, delay: number, stop: AbortController) {
        try {
          await ctx.clock.sleep(delay, stop.signal);
          target.abort();
        } catch (error) {
          if (!stop.signal.aborted) throw error;
        }
      },
      async send() {
        if (state === "closed" || !records.length) return;
        let bytes = 0;
        const retained = records.filter((record, index) => {
          const size = new TextEncoder().encode(JSON.stringify(record.value)).byteLength;
          if (index >= 64 || bytes + size > 48_000) return false;
          bytes += size;
          return true;
        });
        const batch: Telemetry.Batch = {
          traces: retained
            .filter((record) => record.kind === "trace")
            .map((record) => record.value),
          logs: retained.filter((record) => record.kind === "log").map((record) => record.value),
        };
        owned.publish({ kind: "sending", pending: records.length, dropped: dropped });
        const request = new AbortController();
        const deadline = new AbortController();
        const alarm = owned.abortAfter(request, 750, deadline);
        let result: Telemetry.Delivery;
        try {
          result = await delivery.send(
            batch,
            AbortSignal.any([request.signal, stopRequests.signal]),
          );
        } finally {
          deadline.abort();
          await alarm;
        }
        const accepted = new Set(
          retained.filter((record) => (record.kind === "trace" ? result.traces : result.logs)),
        );
        records = records.filter((record) => !accepted.has(record));
        queueBytes = records.reduce(
          (sum, record) => sum + new TextEncoder().encode(JSON.stringify(record.value)).byteLength,
          0,
        );
        failed = !result.traces || !result.logs;
        owned.publish(
          result.traces && result.logs
            ? {
                kind: records.length ? "queued" : "idle",
                pending: records.length,
                dropped: dropped,
              }
            : {
                kind: "failed",
                failure: "Telemetry storage did not accept the batch",
                pending: records.length,
                dropped: dropped,
              },
        );
      },
      async close() {
        if (state !== "open") return;
        state = "closing";
        owned.stopSchedule();
        const deadline = new AbortController();
        const alarm = owned.abortAfter(stopRequests, 1500, deadline);
        try {
          await timer;
          while (records.length && !stopRequests.signal.aborted) {
            await owned.flush();
            if (failed) break;
          }
        } finally {
          state = "closed";
          stopRequests.abort();
          deadline.abort();
          await alarm;
          dropped += records.length;
          records = [];
          queueBytes = 0;
          owned.publish({ kind: "closed", pending: 0, dropped: dropped });
        }
      },
    };
    ctx.defer(() => owned.close());
    return owned;
  },
});
