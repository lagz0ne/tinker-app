import { extension, resource, tag } from "@tinker/core";
import type { Observe } from "@tinker/core";
import { z } from "zod";

import { abortReasons } from "~/components/errors";

import { consoleOutput } from "./console";
import { exportHealth } from "./health";
import { workerThreads } from "./modules.server";
import { encodeValue } from "./records";
import type { Telemetry } from "./records";
import {
  logLevel,
  logsUrl,
  spanHistory,
  telemetryService,
  telemetrySide,
  tracesUrl,
} from "./settings";

/** The built worker command; the server command binds it, so tests and dev stay in process. */
export const telemetryWorker = tag({
  label: "telemetry.worker",
  parse: z.instanceof(URL),
});

/** What the worker command reads from `workerData`; the request side resolves every value. */
export type ThreadSettings = {
  service: string;
  traces: string;
  logs: string;
  fd: number | null;
  /** True when the host's sink has no descriptor: the worker posts its console text back. */
  relay: boolean;
};

/** What the worker posts back: ready, a health report, a flush answer, console text, or its final health. */
export type ThreadMessage =
  | { ready: true }
  | { console: string }
  | { health: Telemetry.Health }
  | { flushed: number }
  | { final: Telemetry.Health };

/** The request thread's side of the ring: what the observers and the worker owner use. */
export type ThreadRing = {
  data: Uint8Array;
  state: Int32Array;
  write(line: string): void;
  push(): void;
  stop(): void;
  dropped(): number;
  /** Called after a turn is dropped, so the owner can publish the count at once. */
  watch(listener: () => void): void;
};

/** What the telemetry root uses of the worker: its start, a flush, and its close. */
export type ThreadWorker = {
  ready: Promise<void>;
  flush(): Promise<void>;
  close(publishFinal: boolean): Promise<void>;
};

/**
 * The request thread's one write: a line into a shared ring, read by a worker thread.
 * The thread-stream design: Atomics, no blocking, and a full ring drops and counts.
 */
export const threadRing = resource({
  label: "telemetry.ring",
  target: "scope",
  factory: (): ThreadRing => {
    const size = 1 << 22;
    const mask = size - 1;
    const data = new Uint8Array(new SharedArrayBuffer(size));
    const state = new Int32Array(new SharedArrayBuffer(8));
    const scratch = new Uint8Array(size);
    const encoder = new TextEncoder();

    let text = "";
    let lines = 0;
    let scheduled = false;
    let dropped = 0;
    let open = true;
    let dropping: (() => void) | undefined;

    const owned = {
      data,
      state,
      write(line: string) {
        if (!open) {
          dropped++;
          return;
        }

        text += line;
        text += "\n";
        lines++;
        if (!scheduled) {
          scheduled = true;
          setImmediate(owned.push);
        }
      },
      /** One copy per event-loop turn: encode the turn's lines, then publish the write index. */
      push: () => {
        scheduled = false;
        if (!lines) return;

        const { read, written } = encoder.encodeInto(text, scratch);
        // The indexes are Int32 and wrap after 2 GiB; the unsigned difference stays right.
        const at = Atomics.load(state, 0);
        const unread = (at - Atomics.load(state, 1)) >>> 0;
        const free = size - unread;

        if (read < text.length || written > free) {
          dropped += lines;
          dropping?.();
        } else {
          const start = at & mask;
          const first = Math.min(written, size - start);
          data.set(scratch.subarray(0, first), start);
          if (first < written) data.set(scratch.subarray(first, written), 0);

          Atomics.store(state, 0, at + written);
          // The worker polls every 10 ms; a wake per turn cost more than the copy itself.
          if (unread + written >= size >> 2) Atomics.notify(state, 0);
        }

        text = "";
        lines = 0;
      },
      /** After the worker stops, every line is dropped and counted. */
      stop() {
        owned.push();
        open = false;
      },
      dropped: () => dropped,
      watch(listener: () => void) {
        dropping = listener;
      },
    };
    return owned;
  },
});

/**
 * Starts the worker on the ring and owns its close; a dead worker stays failed, as pino's does.
 * Close joins the worker's own close (1.5 s for storage); a stuck worker stops at 3 s.
 */
export const telemetryThread = resource({
  label: "telemetry.thread",
  target: "scope",
  depends: {
    threads: workerThreads,
    ring: threadRing,
    module: telemetryWorker.required,
    service: telemetryService,
    tracesUrl: tracesUrl.required,
    logsUrl: logsUrl.required,
    console: consoleOutput,
    health: exportHealth.controller,
  },
  factory: async (
    { threads, ring, module, service, tracesUrl, logsUrl, console, health },
    ctx,
  ): Promise<ThreadWorker> => {
    const fd = typeof console?.fd === "number" ? console.fd : null;
    const relay = console !== null && fd === null;
    const settings: ThreadSettings = {
      service,
      traces: tracesUrl.href,
      logs: logsUrl.href,
      fd,
      relay,
    };
    const worker = new threads.Worker(module, {
      name: "telemetry",
      // The worker inherits Node's flags, but a worker file rejects `--input-type` (from `node -e`).
      // A given list is checked for flags a worker cannot take, so only that case passes one.
      execArgv: process.execArgv.some((flag) => flag.startsWith("--input-type"))
        ? process.execArgv.filter((flag) => !flag.startsWith("--input-type"))
        : undefined,
      workerData: { data: ring.data, state: ring.state, settings },
    });

    let open = true;
    let publishing = true;
    let final: Telemetry.Health | undefined;
    let last: Telemetry.Health = { kind: "idle", pending: 0, dropped: 0 };
    let closing: Promise<void> | undefined;
    const flushes = new Map<number, () => void>();
    let flushId = 0;
    const ready = Promise.withResolvers<void>();
    const exited = Promise.withResolvers<void>();
    void ready.promise.catch(() => {});

    const owned = {
      ready: ready.promise,
      receive(message: ThreadMessage) {
        if ("ready" in message) {
          worker.unref();
          ready.resolve();
        } else if ("health" in message) {
          owned.publish(message.health);
        } else if ("console" in message) {
          console?.write(message.console);
        } else if ("flushed" in message) {
          flushes.get(message.flushed)?.();
          flushes.delete(message.flushed);
        } else final = message.final;
      },
      publish(next: Telemetry.Health) {
        last = next;
        if (publishing) health.set({ ...next, dropped: next.dropped + ring.dropped() });
      },
      /** A drop on the request side: the last report again, with the new count. */
      republish: () => owned.publish(last),
      stopped(failure: string) {
        open = false;
        ring.stop();
        owned.publish({ kind: "failed", failure, pending: 0, dropped: 0 });
      },
      exit() {
        ready.reject(new Error("Telemetry worker exited before ready"));
        if (open) owned.stopped("Telemetry worker exited");
        for (const done of flushes.values()) done();
        flushes.clear();
        exited.resolve();
      },
      flush() {
        ring.push();
        if (!open) return Promise.resolve();

        const id = flushId++;
        const done = new Promise<void>((resolve) => flushes.set(id, resolve));
        worker.postMessage({ flush: id });
        return done;
      },
      close(publishFinal: boolean) {
        return (closing ??= owned.shutdown(publishFinal));
      },
      async shutdown(publishFinal: boolean) {
        ring.stop();
        open = false;
        publishing = false;
        worker.ref();
        worker.postMessage({ close: true });

        const deadline = new AbortController();
        const alarm = ctx.clock.sleep(3000, deadline.signal).then(
          () => worker.terminate(),
          () => {},
        );
        await exited.promise;
        deadline.abort(abortReasons.done);
        await alarm;

        if (!publishFinal) return;
        const last = final ?? {
          kind: "failed" as const,
          failure: "Telemetry worker stopped before its final report",
          pending: 0,
          dropped: 0,
        };
        health.set({ ...last, dropped: last.dropped + ring.dropped() });
      },
    };

    ring.watch(owned.republish);
    worker.on("message", (message: ThreadMessage) => owned.receive(message));
    worker.on("error", (error) => {
      ready.reject(error);
      owned.stopped(`Telemetry worker stopped: ${String(error)}`);
    });
    worker.on("exit", () => owned.exit());

    ctx.defer(() => owned.close(!ctx.signal.aborted));
    return owned;
  },
});

/** On the request side's telemetry root: start waits for the worker; close joins it. */
export const threadExport = extension({
  label: "telemetry.thread",
  hooks: {
    async start(event) {
      await (
        await event.resolve(telemetryThread)
      ).ready;
      await event.next();
    },
    async close(event) {
      await (await event.resolve(telemetryThread)).close(true);
      return event.next();
    },
  },
});

/** The request thread's observer: one JSON.stringify per span or line, then one ring write. */
export const threadObserver = resource({
  label: "telemetry.threadObserver",
  depends: {
    thread: threadRing,
    side: telemetrySide,
    level: logLevel,
    history: spanHistory,
  },
  factory: ({ thread, side, level, history }, ctx): Observe.Config => {
    const owned = {
      history,
      level,
      export(span: Observe.Span) {
        const time = ctx.clock.currentTimeMillis();
        if (owned.plainSpan(span)) {
          try {
            thread.write(JSON.stringify(owned.spanLine(span, time, false)));
            return;
          } catch {
            /* A cycle or a nested bigint: send encoded values instead. */
          }
        }

        thread.write(JSON.stringify(owned.spanLine(span, time, true)));
      },
      log(entry: Observe.Log) {
        if (owned.plain(entry.attributes)) {
          try {
            thread.write(JSON.stringify(owned.logLine(entry, false)));
            return;
          } catch {
            /* Encoded below. */
          }
        }

        thread.write(JSON.stringify(owned.logLine(entry, true)));
      },
      /** True when JSON keeps every attribute value of the span and its events. */
      plainSpan(span: Observe.Span) {
        if (!owned.plain(span.attributes)) return false;
        for (let index = 0; index < span.events.length; index++) {
          if (!owned.plain(span.events[index]!.attributes)) return false;
        }
        return true;
      },
      /** False for a value JSON would lose; the line then carries encoded values. */
      plain(values: Record<string, unknown>) {
        for (const key in values) {
          const type = typeof values[key];
          if (type === "undefined" || type === "bigint" || type === "function") return false;
          if (type === "symbol") return false;
        }
        return true;
      },
      encodeAll(values: Record<string, unknown>) {
        const encoded: Record<string, string> = {};
        for (const key in values) encoded[key] = encodeValue(values[key]);
        return encoded;
      },
      /** Raw span fields for one wire line; `encoded` lines carry `encodeValue` strings. */
      spanLine(span: Observe.Span, time: number, encoded: boolean): Telemetry.Wire {
        return [
          "s",
          side,
          time,
          encoded ? 1 : 0,
          span.traceId,
          span.spanId,
          span.parentSpanId ?? null,
          span.sampled,
          span.name,
          span.kind,
          span.start,
          span.end ?? null,
          span.status ?? null,
          span.status === "failed" ? String(span.error) : null,
          encoded ? owned.encodeAll(span.attributes) : span.attributes,
          encoded ? span.events.map((event) => owned.encodedEvent(event)) : span.events,
        ];
      },
      encodedEvent(event: Observe.Event): Observe.Event {
        return {
          name: event.name,
          time: event.time,
          attributes: owned.encodeAll(event.attributes),
        };
      },
      logLine(entry: Observe.Log, encoded: boolean): Telemetry.Wire {
        return [
          "l",
          side,
          encoded ? 1 : 0,
          entry.level,
          entry.time,
          entry.span?.traceId ?? null,
          entry.span?.spanId ?? null,
          entry.message,
          encoded ? owned.encodeAll(entry.attributes) : entry.attributes,
        ];
      },
    };
    return owned;
  },
});

/** Each render has its own observer namespace; the thread stays shared. */
export const threadRenderObserve = resource({ ...threadObserver, target: "namespace" });

/** A tab's checked batch goes to the worker as one line, under the server's service. */
export const threadIngest = resource({
  label: "telemetry.threadIngest",
  depends: { thread: threadRing, service: telemetryService },
  factory: ({ thread, service }) => ({
    ingest(this: void, batch: Telemetry.Batch) {
      for (const record of batch.logs) record.service = service;
      thread.write(JSON.stringify(["b", batch]));
    },
  }),
});
