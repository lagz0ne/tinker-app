import { resource } from "@tinker/core";
import type { Telemetry } from "./records";
import { delivery } from "./delivery";
import { telemetrySettings } from "./settings";
import { exportHealth } from "./health";

/** Retains failed records within count and byte bounds; this resource owns every promise. */
export const queue = resource({
  label: "telemetry.queue",
  target: "scope",
  depends: { settings: telemetrySettings, health: exportHealth.controller, delivery },
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
        const incoming: typeof records = [
          ...batch.traces.map((value) => ({ kind: "trace" as const, value })),
          ...batch.logs.map((value) => ({ kind: "log" as const, value })),
        ];
        for (const record of incoming) {
          const recordBytes = new TextEncoder().encode(JSON.stringify(record.value)).byteLength;
          if (
            [
              state === "closed",
              recordBytes > 48_000,
              records.length >= 512,
              queueBytes + recordBytes > 1_048_576,
            ].includes(true)
          ) {
            dropped++;
          } else {
            records.push(record);
            queueBytes += recordBytes;
          }
          if (publishing) {
            const previous = health.get();
            health.set(
              previous.kind === "failed"
                ? { ...previous, pending: records.length, dropped }
                : { kind: pending ? "sending" : "queued", pending: records.length, dropped },
            );
          }
        }
      },
      start(flush: () => Promise<void>) {
        if (settings.side !== "ssr")
          timer = Promise.resolve().then(async () => {
            while (!stopTimer.signal.aborted) {
              try {
                await ctx.clock.sleep(1000, stopTimer.signal);
              } catch (error) {
                if (!stopTimer.signal.aborted) throw error;
                return;
              }
              if (!stopTimer.signal.aborted) await flush();
            }
          });
      },
      flush(): Promise<void> {
        return (pending ??= Promise.resolve()
          .then(async () => {
            if (!records.length) return;
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
              logs: retained
                .filter((record) => record.kind === "log")
                .map((record) => record.value),
            };
            if (publishing)
              health.set({ kind: "sending", pending: records.length, dropped: dropped });
            const request = new AbortController();
            const deadline = new AbortController();
            const alarm = Promise.resolve().then(async () => {
              try {
                await ctx.clock.sleep(750, deadline.signal);
                request.abort();
              } catch (error) {
                if (!deadline.signal.aborted) throw error;
              }
            });
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
              (sum, record) =>
                sum + new TextEncoder().encode(JSON.stringify(record.value)).byteLength,
              0,
            );
            failed = !result.traces || !result.logs;
            if (publishing)
              health.set(
                !failed
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
          })
          .finally(() => {
            pending = undefined;
          }));
      },
      async close() {
        if (state !== "open") return;
        state = "closing";
        publishing = false;
        stopTimer.abort();
        const deadline = new AbortController();
        const alarm = Promise.resolve().then(async () => {
          try {
            await ctx.clock.sleep(1500, deadline.signal);
            stopRequests.abort();
          } catch (error) {
            if (!deadline.signal.aborted) throw error;
          }
        });
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
        }
      },
    };
    ctx.defer(() => owned.close());
    return owned;
  },
});
