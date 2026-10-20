import { expect, test } from "vite-plus/test";

import { logRecord, span, telemetryBatch } from "~/components/telemetry/records.server";

const trace = {
  side: "worker",
  traceId: "1".repeat(32),
  spanId: "a".repeat(16),
  flags: 1,
  name: "mail.worker",
  kind: 1,
  startTimeUnixNano: "1",
  endTimeUnixNano: "2",
  attributes: [{ key: "batch", value: { stringValue: "20" } }],
  events: [{ name: "saved", timeUnixNano: "1", attributes: [] }],
  status: { code: 1 },
};

const line = { time: 0, level: 30, msg: "saved", service: "proof", side: "worker" };

for (const side of ["worker", "server", "browser", "ssr"]) {
  test(`${side} trace and log retain every wire field`, () => {
    expect(span.parse({ ...trace, side })).toEqual({ ...trace, side });
    expect(logRecord.parse({ ...line, side })).toEqual({ ...line, side });
    expect(span.safeParse({ ...trace, side: "other" }).success).toBe(false);
    expect(logRecord.safeParse({ ...line, side: "other" }).success).toBe(false);
  });
}

for (const [field, length] of [
  ["traceId", 32],
  ["spanId", 16],
  ["parentSpanId", 16],
] as const) {
  test(`${field} takes only a full lowercase hex ID`, () => {
    expect(span.parse({ ...trace, [field]: "f".repeat(length) })).toMatchObject({
      [field]: "f".repeat(length),
    });

    for (const value of [
      "f".repeat(length - 1),
      "f".repeat(length + 1),
      "F".repeat(length),
      "g".repeat(length),
      " " + "f".repeat(length),
      "f".repeat(length) + " ",
    ]) {
      expect(span.safeParse({ ...trace, [field]: value }).success, value).toBe(false);
    }
    if (field !== "parentSpanId") {
      expect(span.safeParse({ ...trace, [field]: "0".repeat(length) }).success).toBe(false);
    }
  });
}

for (const field of ["startTimeUnixNano", "endTimeUnixNano"]) {
  test(`${field} takes one to twenty digits and no other text`, () => {
    for (const value of ["0", "1".repeat(20)]) {
      expect(span.parse({ ...trace, [field]: value })).toMatchObject({ [field]: value });
    }

    for (const value of ["", "1".repeat(21), "-1", "x", "x1", "1x", "1.5"]) {
      expect(span.safeParse({ ...trace, [field]: value }).success, value).toBe(false);
    }
  });
}

test("span text and collection limits accept the edge and reject one more", () => {
  const attribute = { key: "k".repeat(256), value: { stringValue: "v".repeat(2048) } };
  const event = {
    name: "e".repeat(256),
    timeUnixNano: "1".repeat(20),
    attributes: Array(32).fill(attribute),
  };
  const edge = {
    ...trace,
    name: "n".repeat(256),
    attributes: Array(32).fill(attribute),
    events: Array(32).fill(event),
    status: { code: 2, message: "m".repeat(2048) },
  };

  expect(span.parse(edge)).toEqual(edge);
  for (const value of [
    { ...edge, name: "n".repeat(257) },
    { ...edge, attributes: Array(33).fill(attribute) },
    { ...edge, events: Array(33).fill(event) },
    { ...edge, status: { code: 2, message: "m".repeat(2049) } },
    { ...edge, attributes: [{ ...attribute, key: "k".repeat(257) }] },
    { ...edge, attributes: [{ key: "k", value: { stringValue: "v".repeat(2049) } }] },
  ]) {
    expect(span.safeParse(value).success).toBe(false);
  }
});

test("event names, times, attributes, and extra fields are checked too", () => {
  const event = { name: "saved", timeUnixNano: "1", attributes: [] };
  expect(span.parse({ ...trace, events: [event] })).toMatchObject({ events: [event] });

  for (const value of [
    { ...event, name: "e".repeat(257) },
    { ...event, timeUnixNano: "" },
    { ...event, timeUnixNano: "x1" },
    { ...event, timeUnixNano: "1x" },
    { ...event, timeUnixNano: "1".repeat(21) },
    { ...event, attributes: Array(33).fill({ key: "k", value: { stringValue: "v" } }) },
    { ...event, extra: 1 },
  ]) {
    expect(span.safeParse({ ...trace, events: [value] }).success).toBe(false);
  }
});

test("span flags, kind, and status codes keep their supported values", () => {
  expect(span.parse({ ...trace, flags: 0, status: { code: 2 } })).toMatchObject({
    flags: 0,
    status: { code: 2 },
  });

  for (const value of [
    { ...trace, flags: 2 },
    { ...trace, kind: 2 },
    { ...trace, status: { code: 0 } },
    { ...trace, status: { code: 3 } },
  ]) {
    expect(span.safeParse(value).success).toBe(false);
  }
});

test("log time, level, service, and message bounds accept their edges", () => {
  expect(logRecord.parse({ ...line, level: 10 })).toMatchObject({ time: 0, level: 10 });
  expect(
    logRecord.parse({ ...line, level: 60, service: "s".repeat(128), msg: "m".repeat(2048) }),
  ).toMatchObject({ level: 60 });

  for (const value of [
    { ...line, time: -1 },
    { ...line, time: 1.5 },
    { ...line, level: 9 },
    { ...line, level: 61 },
    { ...line, level: 30.5 },
    { ...line, service: "" },
    { ...line, service: "s".repeat(129) },
    { ...line, msg: "m".repeat(2049) },
  ]) {
    expect(logRecord.safeParse(value).success).toBe(false);
  }
});

test("log optional IDs and attributes still check their wire types", () => {
  const value = {
    ...line,
    traceId: trace.traceId,
    spanId: trace.spanId,
    attributes: { ["k".repeat(256)]: "v".repeat(2048) },
  };
  expect(logRecord.parse(value)).toEqual(value);

  for (const bad of [
    { ...value, traceId: "x" + trace.traceId },
    { ...value, traceId: trace.traceId + "x" },
    { ...value, spanId: "x" + trace.spanId },
    { ...value, spanId: trace.spanId + "x" },
    { ...value, attributes: { ["k".repeat(257)]: "v" } },
    { ...value, attributes: { k: "v".repeat(2049) } },
    { ...value, attributes: { k: 1 } },
  ]) {
    expect(logRecord.safeParse(bad).success).toBe(false);
  }
});

test("one telemetry batch holds at most sixty-four records across both lists", () => {
  const edge = { traces: Array(32).fill(trace), logs: Array(32).fill(line) };
  expect(telemetryBatch.parse(edge)).toEqual(edge);
  expect(telemetryBatch.parse({ traces: [], logs: [] })).toEqual({ traces: [], logs: [] });

  for (const value of [
    { ...edge, traces: Array(33).fill(trace) },
    { traces: Array(65).fill(trace), logs: [] },
    { traces: [], logs: Array(65).fill(line) },
  ]) {
    expect(telemetryBatch.safeParse(value).success).toBe(false);
  }
});

test("wire objects refuse unknown top-level and nested fields", () => {
  expect(span.safeParse({ ...trace, extra: 1 }).success).toBe(false);
  expect(
    span.safeParse({ ...trace, attributes: [{ key: "k", value: { stringValue: "v", extra: 1 } }] })
      .success,
  ).toBe(false);
  expect(span.safeParse({ ...trace, status: { code: 1, extra: 1 } }).success).toBe(false);

  expect(logRecord.safeParse({ ...line, extra: 1 }).success).toBe(false);
  expect(telemetryBatch.safeParse({ traces: [], logs: [], extra: 1 }).success).toBe(false);
});
