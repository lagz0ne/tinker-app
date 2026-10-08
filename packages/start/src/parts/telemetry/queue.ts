import { abortReasons } from "../../errors";
import { resource } from "@tinker/core";
import type { Telemetry } from "./records";
import { delivery } from "./delivery";
import { telemetrySettings } from "./settings";
import { exportHealth } from "./health";

/** One encoder for every record size; sizes are taken once, at ingest. */
const encoder = new TextEncoder();

/** Retains failed records within count and byte bounds; this resource owns every promise. */
export const queue = resource({
  label: "telemetry.queue",
  target: "scope",
  depends: { settings: telemetrySettings, health: exportHealth.controller, delivery },
  factory: ({ settings, health, delivery }, ctx) => {
    let records: Telemetry.Record[] = [];
    const browser = settings.side === "browser";
    const batchLimit = browser ? 32_000 : 48_000;
    /** Reserve the JSON envelope and one comma per browser record. */
    const recordLimit = browser ? batchLimit - 24 : batchLimit;
    const frameBytes = browser ? 23 : 0;
    const commaBytes = browser ? 1 : 0;
    const scratch = new Uint8Array(recordLimit + 4);
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
        for (let index = 0; index < batch.traces.length; index++) {
          const { side, ...value } = batch.traces[index]!;
          owned.add("trace", side, value);
        }
        for (let index = 0; index < batch.logs.length; index++) {
          const value = batch.logs[index]!;
          owned.add("log", value.side, value);
        }
        if (batch.traces.length + batch.logs.length) owned.publishQueued();
      },
      add(
        kind: Telemetry.Record["kind"],
        side: Telemetry.Side,
        value: Telemetry.SpanBody | Telemetry.Log,
      ) {
        if (state === "closed" || records.length >= 512) {
          dropped++;
          return;
        }
        const json = JSON.stringify(value);
        const { read, written } = encoder.encodeInto(json, scratch);
        const bytes = written + (kind === "trace" ? side.length + 10 : 0);
        if (read < json.length || bytes > recordLimit || queueBytes + bytes > 1_048_576) {
          dropped++;
        } else {
          records.push({ kind, side, json, bytes });
          queueBytes += bytes;
        }
        return json;
      },
      publishQueued() {
        if (publishing) {
          const previous = health.get();
          health.set(
            previous.kind === "failed"
              ? { ...previous, pending: records.length, dropped }
              : { kind: pending ? "sending" : "queued", pending: records.length, dropped },
          );
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
      takeBatch() {
        let bytes = frameBytes;
        const retained: typeof records = [];
        for (const record of records.slice(0, 64)) {
          const size = record.bytes + commaBytes;
          if (bytes + size > batchLimit) continue;
          bytes += size;
          retained.push(record);
        }
        return retained;
      },
      flush(): Promise<void> {
        return (pending ??= Promise.resolve()
          .then(async () => {
            if (!records.length) return;
            const retained = owned.takeBatch();
            if (publishing)
              health.set({ kind: "sending", pending: records.length, dropped: dropped });
            const request = new AbortController();
            const deadline = new AbortController();
            const alarm = Promise.resolve().then(async () => {
              try {
                await ctx.clock.sleep(750, deadline.signal);
                request.abort(abortReasons.timeout);
              } catch (error) {
                if (!deadline.signal.aborted) throw error;
              }
            });
            let result: Telemetry.Delivery;
            try {
              result = await delivery.send(
                retained,
                AbortSignal.any([request.signal, stopRequests.signal]),
              );
            } finally {
              deadline.abort(abortReasons.done);
              await alarm;
            }
            const accepted = new Set(
              retained.filter((record) => (record.kind === "trace" ? result.traces : result.logs)),
            );
            records = records.filter((record) => !accepted.has(record));
            for (const record of accepted) queueBytes -= record.bytes;
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
        stopTimer.abort(abortReasons.closed);
        const deadline = new AbortController();
        const alarm = Promise.resolve().then(async () => {
          try {
            await ctx.clock.sleep(1500, deadline.signal);
            stopRequests.abort(abortReasons.timeout);
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
          stopRequests.abort(abortReasons.closed);
          deadline.abort(abortReasons.done);
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
