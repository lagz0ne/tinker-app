import { createScope } from "@tinker/core";
import { expect, test } from "vite-plus/test";

import { backendStop, requestStop } from "~/components/requests";
import { browserTelemetry, receiveTelemetry } from "~/components/telemetry/ingest.server";
import { encodeValue, quiet, spanBody } from "~/components/telemetry/records";
import type { Telemetry } from "~/components/telemetry/records";

const traceId = "0123456789abcdef0123456789abcdef";
const spanId = "0123456789abcdef";
const pair = { key: "k", value: { stringValue: "v" } };

const span = (side: Telemetry.Side): Telemetry.Span => ({
  side,
  traceId,
  spanId,
  parentSpanId: "fedcba9876543210",
  flags: 1,
  name: "n",
  kind: 1,
  startTimeUnixNano: "12",
  endTimeUnixNano: "34",
  attributes: [pair],
  events: [{ name: "e", timeUnixNano: "56", attributes: [pair] }],
  status: { code: 2, message: "m" },
});

const log = (side: Telemetry.Side): Telemetry.Log => ({
  time: 1,
  level: 30,
  msg: "m",
  service: "s",
  side,
  traceId,
  spanId,
  attributes: { k: "v" },
});

const sides: Telemetry.Side[] = ["server", "browser", "ssr"];
const good = { traces: sides.map(span), logs: sides.map(log) };

const withSpan = (change: Record<string, unknown>) => ({
  traces: [{ ...span("browser"), ...change }],
  logs: [],
});

const withEvent = (change: Record<string, unknown>) =>
  withSpan({ events: [{ ...span("browser").events[0], ...change }] });

const withLog = (change: Record<string, unknown>) => ({
  traces: [],
  logs: [{ ...log("browser"), ...change }],
});

test("a batch is taken only when every record keeps the wire rules", async () => {
  const taken: unknown[] = [];
  const stop = new AbortController();
  const root = createScope({
    tags: [
      backendStop(stop.signal),
      requestStop(stop.signal),
      browserTelemetry((batch) => {
        taken.push(batch);
      }),
    ],
  });

  const full = {
    traces: Array.from({ length: 32 }, () => span("ssr")),
    logs: Array.from({ length: 32 }, () => log("ssr")),
  };
  const refused = {
    "a trace id with a lead": withSpan({ traceId: `x${traceId}` }),
    "a trace id with a tail": withSpan({ traceId: `${traceId}x` }),
    "a trace id of zeros": withSpan({ traceId: "0".repeat(32) }),
    "a span id with a lead": withSpan({ spanId: `x${spanId}` }),
    "a span id with a tail": withSpan({ spanId: `${spanId}x` }),
    "a span id of zeros": withSpan({ spanId: "0".repeat(16) }),
    "a parent id with a lead": withSpan({ parentSpanId: `x${spanId}` }),
    "a parent id with a tail": withSpan({ parentSpanId: `${spanId}x` }),
    "a span name over 256": withSpan({ name: "n".repeat(257) }),
    "a start with a lead": withSpan({ startTimeUnixNano: "x12" }),
    "a start with a tail": withSpan({ startTimeUnixNano: "12x" }),
    "an end with a lead": withSpan({ endTimeUnixNano: "x34" }),
    "an end with a tail": withSpan({ endTimeUnixNano: "34x" }),
    "33 span attributes": withSpan({ attributes: Array.from({ length: 33 }, () => pair) }),
    "an attribute key over 256": withSpan({ attributes: [{ ...pair, key: "k".repeat(257) }] }),
    "an attribute value over 2048": withSpan({
      attributes: [{ key: "k", value: { stringValue: "v".repeat(2049) } }],
    }),
    "an attribute with more keys": withSpan({ attributes: [{ ...pair, extra: 1 }] }),
    "33 events": withSpan({ events: Array.from({ length: 33 }, () => span("ssr").events[0]) }),
    "an event name over 256": withEvent({ name: "e".repeat(257) }),
    "an event time with a lead": withEvent({ timeUnixNano: "x56" }),
    "an event time with a tail": withEvent({ timeUnixNano: "56x" }),
    "33 event attributes": withEvent({ attributes: Array.from({ length: 33 }, () => pair) }),
    "an event with more keys": withEvent({ extra: 1 }),
    "a status message over 2048": withSpan({ status: { code: 2, message: "m".repeat(2049) } }),
    "a status with more keys": withSpan({ status: { code: 1, extra: 1 } }),
    "a side no record has": withSpan({ side: "client" }),
    "a log trace id with a lead": withLog({ traceId: `x${traceId}` }),
    "a log trace id with a tail": withLog({ traceId: `${traceId}x` }),
    "a log span id with a lead": withLog({ spanId: `x${spanId}` }),
    "a log span id with a tail": withLog({ spanId: `${spanId}x` }),
    "a log attribute key over 256": withLog({ attributes: { ["k".repeat(257)]: "v" } }),
    "a log attribute value over 2048": withLog({ attributes: { k: "v".repeat(2049) } }),
    "65 records": { traces: full.traces, logs: [...full.logs, log("ssr")] },
  };

  for (const [name, batch] of [
    ["every side, every field", good],
    ["64 records", full],
  ] as const) {
    expect(root.settle(receiveTelemetry, { rawInput: batch }).status, name).toBe("success");
  }
  for (const [name, batch] of Object.entries(refused)) {
    expect(root.settle(receiveTelemetry, { rawInput: batch }).status, name).toBe("failed");
  }

  expect(taken).toEqual([good, full]);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a value is cut to 2048 characters; a bigint, undefined, or a cycle still encodes", () => {
  const root = createScope();
  const encode = (input: unknown) => root.run(encodeValue, { input, ns: quiet });

  expect(encode(10n ** 2100n)).toBe((10n ** 2100n).toString().slice(0, 2048));
  expect(encode("x".repeat(3000))).toBe(`"${"x".repeat(2047)}`);
  expect(encode(7)).toBe("7");
  expect(encode(true)).toBe("true");
  expect(encode({ n: 1n })).toBe('{"n":"1"}');
  expect(encode({ s: "y".repeat(3000) })).toHaveLength(2048);
  expect(encode(undefined)).toBe("undefined");
  expect(encode(() => 1)).toBe("undefined");

  const cycle: Record<string, unknown> = {};
  cycle.loop = cycle;

  expect(encode(cycle)).toBe("[Unserializable]");
});

const fields: Telemetry.SpanFields = {
  traceId,
  spanId,
  parentSpanId: "fedcba9876543210",
  sampled: true,
  name: "n".repeat(300),
  kind: "operation",
  start: 12.9,
  end: undefined,
  status: "failed",
  error: "e".repeat(3000),
  attributes: { ["k".repeat(300)]: 1n, plain: "v", ...wide("a") },
  events: [
    { name: "e".repeat(300), time: 0, attributes: { big: 2n, ...wide("b") } },
    ...Array.from({ length: 32 }, () => ({ name: "more", time: 5, attributes: {} })),
  ],
};

/**
 * Forty attributes, so a body shows its cut at 31.
 * @param prefix - From a test; why: keep span and event keys apart.
 */
function wide(prefix: string) {
  return Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`${prefix}${index}`, index]));
}

test("a span becomes its OTLP body: cut names, 31 attributes, 32 events, failed status", () => {
  const root = createScope();
  const body = root.run(spanBody, { input: { span: fields, encoded: false }, ns: quiet });

  expect(body).toEqual({
    traceId,
    spanId,
    parentSpanId: "fedcba9876543210",
    flags: 1,
    name: "n".repeat(256),
    kind: 1,
    startTimeUnixNano: "12000000",
    endTimeUnixNano: "12000000",
    attributes: [
      { key: "k".repeat(256), value: { stringValue: "1" } },
      { key: "plain", value: { stringValue: '"v"' } },
      ...Array.from({ length: 29 }, (_, index) => ({
        key: `a${index}`,
        value: { stringValue: String(index) },
      })),
      { key: "tinker.kind", value: { stringValue: "operation" } },
    ],
    events: [
      {
        name: "e".repeat(256),
        timeUnixNano: "0",
        attributes: [
          { key: "big", value: { stringValue: "2" } },
          ...Array.from({ length: 30 }, (_, index) => ({
            key: `b${index}`,
            value: { stringValue: String(index) },
          })),
        ],
      },
      ...Array.from({ length: 31 }, () => ({
        name: "more",
        timeUnixNano: "5000000",
        attributes: [],
      })),
    ],
    status: { code: 2, message: "e".repeat(2048) },
  });
});

test("a worker line's encoded values pass as they are; an unsampled ok span keeps its end", () => {
  const root = createScope();
  const span: Telemetry.SpanFields = {
    ...fields,
    name: "w",
    sampled: false,
    start: 0,
    end: 34,
    status: "ok",
    attributes: { k: '"v"' },
    events: [{ name: "e", time: 56, attributes: { k: "1" } }],
  };

  expect(root.run(spanBody, { input: { span, encoded: true }, ns: quiet })).toEqual({
    traceId,
    spanId,
    parentSpanId: "fedcba9876543210",
    flags: 0,
    name: "w",
    kind: 1,
    startTimeUnixNano: "0",
    endTimeUnixNano: "34000000",
    attributes: [
      { key: "k", value: { stringValue: '"v"' } },
      { key: "tinker.kind", value: { stringValue: "operation" } },
    ],
    events: [
      {
        name: "e",
        timeUnixNano: "56000000",
        attributes: [{ key: "k", value: { stringValue: "1" } }],
      },
    ],
    status: { code: 1 },
  });
});

test("the encode runs trace through their dependency, and the quiet bucket makes no span", () => {
  const root = createScope({ observe: { history: 16 } });
  const span = { ...fields, attributes: { k: 1 }, events: [] };

  root.run(spanBody, { input: { span, encoded: false } });

  expect(root.spans().map(({ name }) => name)).toEqual([
    "telemetry.encodeValue",
    "telemetry.spanBody",
  ]);

  root.run(spanBody, { input: { span, encoded: false }, ns: quiet });
  root.run(encodeValue, { input: 1, ns: quiet });

  expect(root.spans()).toHaveLength(2);
});
