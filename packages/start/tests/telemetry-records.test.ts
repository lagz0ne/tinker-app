import { createScope } from "@tinker/core";
import { expect, test } from "vite-plus/test";
import { backendStop, requestStop } from "../src/backend/lifetime";
import { browserTelemetry, receiveTelemetry } from "../src/parts/telemetry/ingest.server";
import { encodeValue } from "../src/parts/telemetry/records";
import type { Telemetry } from "../src/parts/telemetry/records";

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
      browserTelemetry(async (batch) => {
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
  ] as const)
    expect((await root.settle(receiveTelemetry, { rawInput: batch })).status, name).toBe("success");
  for (const [name, batch] of Object.entries(refused))
    expect((await root.settle(receiveTelemetry, { rawInput: batch })).status, name).toBe("failed");
  expect(taken).toEqual([good, full]);
  expect((await root.close({ graceful: true })).status).toBe("success");
});

test("a value is cut to 2048 characters; a bigint, undefined, or a cycle still encodes", () => {
  expect(encodeValue(10n ** 2100n)).toBe((10n ** 2100n).toString().slice(0, 2048));
  expect(encodeValue("x".repeat(3000))).toBe(`"${"x".repeat(2047)}`);
  expect(encodeValue({ n: 1n })).toBe('{"n":"1"}');
  expect(encodeValue(undefined)).toBe("undefined");
  const cycle: Record<string, unknown> = {};
  cycle.loop = cycle;
  expect(encodeValue(cycle)).toBe("[Unserializable]");
});
