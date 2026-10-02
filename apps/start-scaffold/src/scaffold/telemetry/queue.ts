import type { Clock, Scope } from "@tinker/core";
import type { Telemetry } from "./records.ts";
import { deliver } from "./delivery.ts";

/** Retains failed records within count and byte bounds. The telemetry root owns every promise. */
export class TelemetryQueue {
  private records: (
    | { kind: "trace"; value: Telemetry.Span }
    | { kind: "log"; value: Telemetry.Log }
  )[] = [];
  private bytes = 0;
  private dropped = 0;
  private timer?: Promise<void>;
  private pending?: Promise<void>;
  private stopTimer = new AbortController();
  private stopRequests = new AbortController();
  private state: "open" | "closing" | "closed" = "open";
  private publishing = true;
  private failed = false;
  private settings: Telemetry.Settings;
  private clock: Clock.Handle;
  private health: Scope.DataController<Telemetry.Health>;

  constructor(
    settings: Telemetry.Settings,
    clock: Clock.Handle,
    health: Scope.DataController<Telemetry.Health>,
  ) {
    this.settings = settings;
    this.clock = clock;
    this.health = health;
  }
  ingest(batch: Telemetry.Batch) {
    for (const value of batch.traces) this.add({ kind: "trace", value });
    for (const value of batch.logs) this.add({ kind: "log", value });
  }
  private add(record: (typeof this.records)[number]) {
    const bytes = new TextEncoder().encode(JSON.stringify(record.value)).byteLength;
    if (
      this.state === "closed" ||
      bytes > 48_000 ||
      this.records.length >= 512 ||
      this.bytes + bytes > 1_048_576
    ) {
      this.dropped++;
    } else {
      this.records.push(record);
      this.bytes += bytes;
    }
    if (this.publishing) {
      const previous = this.health.get();
      this.publish(
        previous.kind === "failed"
          ? { ...previous, pending: this.records.length, dropped: this.dropped }
          : {
              kind: this.pending ? "sending" : "queued",
              pending: this.records.length,
              dropped: this.dropped,
            },
      );
    }
  }
  start(flush: () => Promise<void>) {
    if (this.settings.side !== "ssr") this.timer = this.runTimer(flush);
  }
  private async runTimer(flush: () => Promise<void>) {
    while (!this.stopTimer.signal.aborted) {
      try {
        await this.clock.sleep(1000, this.stopTimer.signal);
      } catch (error) {
        if (!this.stopTimer.signal.aborted) throw error;
        return;
      }
      if (!this.stopTimer.signal.aborted) await flush();
    }
  }
  stopSchedule() {
    this.publishing = false;
    this.stopTimer.abort();
  }
  private publish(state: Telemetry.Health) {
    if (this.publishing) this.health.set(state);
  }
  flush(): Promise<void> {
    return (this.pending ??= this.send().finally(() => {
      this.pending = undefined;
    }));
  }
  private async abortAfter(target: AbortController, delay: number, stop: AbortController) {
    try {
      await this.clock.sleep(delay, stop.signal);
      target.abort();
    } catch (error) {
      if (!stop.signal.aborted) throw error;
    }
  }
  private async send() {
    if (this.state === "closed" || !this.records.length) return;
    let bytes = 0;
    const retained = this.records.filter((record, index) => {
      const size = new TextEncoder().encode(JSON.stringify(record.value)).byteLength;
      if (index >= 64 || bytes + size > 48_000) return false;
      bytes += size;
      return true;
    });
    const batch: Telemetry.Batch = {
      traces: retained.filter((record) => record.kind === "trace").map((record) => record.value),
      logs: retained.filter((record) => record.kind === "log").map((record) => record.value),
    };
    this.publish({ kind: "sending", pending: this.records.length, dropped: this.dropped });
    const request = new AbortController();
    const deadline = new AbortController();
    const alarm = this.abortAfter(request, 750, deadline);
    let result: Telemetry.Delivery;
    try {
      result = await deliver(
        this.settings,
        batch,
        AbortSignal.any([request.signal, this.stopRequests.signal]),
      );
    } finally {
      deadline.abort();
      await alarm;
    }
    const accepted = new Set(
      retained.filter((record) => (record.kind === "trace" ? result.traces : result.logs)),
    );
    this.records = this.records.filter((record) => !accepted.has(record));
    this.bytes = this.records.reduce(
      (sum, record) => sum + new TextEncoder().encode(JSON.stringify(record.value)).byteLength,
      0,
    );
    this.failed = !result.traces || !result.logs;
    this.publish(
      result.traces && result.logs
        ? {
            kind: this.records.length ? "queued" : "idle",
            pending: this.records.length,
            dropped: this.dropped,
          }
        : {
            kind: "failed",
            failure: "Telemetry storage did not accept the batch",
            pending: this.records.length,
            dropped: this.dropped,
          },
    );
  }
  async close() {
    if (this.state !== "open") return;
    this.state = "closing";
    this.stopSchedule();
    const deadline = new AbortController();
    const alarm = this.abortAfter(this.stopRequests, 1500, deadline);
    try {
      await this.timer;
      while (this.records.length && !this.stopRequests.signal.aborted) {
        await this.flush();
        if (this.failed) break;
      }
    } finally {
      this.state = "closed";
      this.stopRequests.abort();
      deadline.abort();
      await alarm;
      this.dropped += this.records.length;
      this.records = [];
      this.bytes = 0;
      this.publish({ kind: "closed", pending: 0, dropped: this.dropped });
    }
  }
}
