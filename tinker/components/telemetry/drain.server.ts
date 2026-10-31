import { LEVELS, resource } from "@tinker/core";

import { exportHealth } from "./health";
import { queue } from "./queue";
import { encodeValue, quiet, spanBody } from "./records";
import type { Telemetry } from "./records";
import { telemetryService } from "./settings";

type SpanLine = Extract<Telemetry.Wire, [tag: "s", ...rest: unknown[]]>;
type LogLine = Extract<Telemetry.Wire, [tag: "l", ...rest: unknown[]]>;

/**
 * Worker side: one wire line becomes the same queue records the in-process observer makes.
 * The worker's own root owns the queue, its batches, and the console mirror.
 * Health crosses threads only when its kind changes; every returned send changes it.
 */
export const threadDrain = resource({
  label: "telemetry.drain",
  depends: {
    queue,
    service: telemetryService,
    health: exportHealth.controller,
    encodeValue,
    spanBody,
  },
  factory: ({ queue, service, health, encodeValue, spanBody }, ctx) => {
    let bad = 0;
    let changes = 0;
    let reported = -1;
    let changed: (() => void) | undefined;

    ctx.defer(
      health.watch((next, previous) => {
        if (next.kind === previous.kind) return;
        changes++;
        changed?.();
      }),
    );

    const owned = {
      /** The worker glue's wake-up: called on each kind change, so it can post soon after. */
      watch(listener: () => void) {
        changed = listener;
      },
      /** Health with unreadable lines counted as dropped. */
      health(): Telemetry.Health {
        const current = health.get();
        return { ...current, dropped: current.dropped + bad };
      },
      /** The health to post, or undefined when its kind has not changed since the last post. */
      report() {
        if (changes === reported) return undefined;
        reported = changes;
        return owned.health();
      },
      /** Sends what is queued now; the request side's `telemetryThread.flush` waits on it. */
      flush() {
        return queue.flush();
      },
      /** Sends what is left within the queue's 1.5 s close budget, then returns the final health. */
      async close() {
        await queue.close(true);
        return owned.health();
      },
      take(line: string) {
        let wire: Telemetry.Wire;
        try {
          wire = JSON.parse(line) as Telemetry.Wire;
        } catch {
          bad++;
          return;
        }

        if (wire[0] === "b") queue.ingest(wire[1]);
        else if (wire[0] === "s") owned.span(wire);
        else owned.log(wire);
      },
      span(wire: SpanLine) {
        const [, side, time, encoded, traceId, spanId, parentSpanId, sampled, name, kind] = wire;
        const [, , , , , , , , , , start, end, status, error, attributes, events] = wire;
        const span: Telemetry.SpanFields = {
          traceId,
          spanId,
          parentSpanId: parentSpanId ?? undefined,
          sampled,
          name,
          kind,
          start,
          end: end ?? undefined,
          status: status ?? undefined,
          error: error ?? undefined,
          attributes,
          events,
        };
        queue.add(
          "trace",
          side,
          spanBody.run({ input: { span, encoded: encoded === 1 }, ns: quiet }),
        );

        const record: Telemetry.Log = {
          level: LEVELS.info,
          time,
          service,
          side,
          traceId,
          spanId,
          attributes: undefined,
          msg: "core.span",
        };
        queue.writeConsole(queue.add("log", side, record), record);

        queue.publishQueued();
      },
      log(wire: LogLine) {
        const [, side, encoded, level, time, traceId, spanId, message, attributes] = wire;
        const record: Telemetry.Log = {
          level,
          time,
          service,
          side,
          traceId: traceId ?? undefined,
          spanId: spanId ?? undefined,
          attributes: Object.fromEntries(
            Object.entries(attributes).map(([key, value]) => [
              key.slice(0, 256),
              encoded ? (value as string) : encodeValue.run({ input: value, ns: quiet }),
            ]),
          ),
          msg: message.slice(0, 2048),
        };
        queue.writeConsole(queue.add("log", side, record), record);

        queue.publishQueued();
      },
    };
    return owned;
  },
});
