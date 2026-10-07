import { expect, test } from "vite-plus/test";
import {
  batchEnvelope,
  bootstrapEnvelope,
  eventEnvelope,
  readCursor,
  readExecution,
  readPrivateCursor,
  readRetry,
  snapshotEnvelope,
} from "../src/index";

const id = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const event = {
  stream: "public",
  revision: 1,
  executionId: id,
  payload: { kind: "change", change: 1 },
};
const snapshot = { public: { stream: "public", revision: 0, value: 1 }, private: null };

test("the sync readers take an app's wire values, and refuse each broken one", () => {
  const cases: [string, (raw: unknown) => unknown, unknown, boolean][] = [
    ["an execution", readExecution, { executionId: id }, true],
    ["an execution id that is no UUID", readExecution, { executionId: "1" }, false],
    ["an execution with more keys", readExecution, { executionId: id, extra: 1 }, false],
    ["a retry", readRetry, { executionId: id, previousExecutionId: other }, true],
    ["a retry with no UUID", readRetry, { executionId: id, previousExecutionId: "1" }, false],
    [
      "a retry with more keys",
      readRetry,
      { executionId: id, previousExecutionId: other, x: 1 },
      false,
    ],
    ["a cursor", (raw) => readCursor.parse(raw), { after: 0 }, true],
    ["a cursor below 0", (raw) => readCursor.parse(raw), { after: -1 }, false],
    ["a cursor between revisions", (raw) => readCursor.parse(raw), { after: 1.5 }, false],
    ["a cursor with more keys", (raw) => readCursor.parse(raw), { after: 1, x: 1 }, false],
    ["a private cursor", (raw) => readPrivateCursor.parse(raw), { accountId: "a", after: 3 }, true],
    [
      "a private cursor with no account",
      (raw) => readPrivateCursor.parse(raw),
      { accountId: "", after: 0 },
      false,
    ],
    [
      "a private cursor below 0",
      (raw) => readPrivateCursor.parse(raw),
      { accountId: "a", after: -1 },
      false,
    ],
    [
      "a private cursor with more keys",
      (raw) => readPrivateCursor.parse(raw),
      { accountId: "a", after: 0, x: 1 },
      false,
    ],
    ["an event", (raw) => eventEnvelope.parse(raw), event, true],
    [
      "a result event",
      (raw) => eventEnvelope.parse(raw),
      { ...event, payload: { kind: "result", result: "r" } },
      true,
    ],
    ["an event at revision 0", (raw) => eventEnvelope.parse(raw), { ...event, revision: 0 }, false],
    [
      "an event between revisions",
      (raw) => eventEnvelope.parse(raw),
      { ...event, revision: 1.5 },
      false,
    ],
    [
      "an event with no UUID",
      (raw) => eventEnvelope.parse(raw),
      { ...event, executionId: "1" },
      false,
    ],
    [
      "an event of another kind",
      (raw) => eventEnvelope.parse(raw),
      { ...event, payload: { kind: "other" } },
      false,
    ],
    ["an event with no stream", (raw) => eventEnvelope.parse(raw), { ...event, stream: 1 }, false],
    ["a snapshot", (raw) => snapshotEnvelope.parse(raw), snapshot, true],
    [
      "an account snapshot",
      (raw) => snapshotEnvelope.parse(raw),
      { ...snapshot, private: { stream: "a", revision: 2 } },
      true,
    ],
    [
      "a snapshot of another stream",
      (raw) => snapshotEnvelope.parse(raw),
      { ...snapshot, public: { stream: "a", revision: 0 } },
      false,
    ],
    [
      "a snapshot below 0",
      (raw) => snapshotEnvelope.parse(raw),
      { ...snapshot, public: { stream: "public", revision: -1 } },
      false,
    ],
    [
      "an account snapshot below 0",
      (raw) => snapshotEnvelope.parse(raw),
      { ...snapshot, private: { stream: "a", revision: -1 } },
      false,
    ],
    [
      "an account snapshot with no stream",
      (raw) => snapshotEnvelope.parse(raw),
      { ...snapshot, private: { revision: 0 } },
      false,
    ],
    ["a batch", (raw) => batchEnvelope.parse(raw), { version: 0, events: [event] }, true],
    [
      "a batch below version 0",
      (raw) => batchEnvelope.parse(raw),
      { version: -1, events: [] },
      false,
    ],
    [
      "a batch between versions",
      (raw) => batchEnvelope.parse(raw),
      { version: 0.5, events: [] },
      false,
    ],
    [
      "a batch with a broken event",
      (raw) => batchEnvelope.parse(raw),
      { version: 0, events: [{}] },
      false,
    ],
    ["a bootstrap", (raw) => bootstrapEnvelope.parse(raw), { version: 2, snapshot }, true],
    [
      "a bootstrap below version 0",
      (raw) => bootstrapEnvelope.parse(raw),
      { version: -1, snapshot },
      false,
    ],
    [
      "a bootstrap between versions",
      (raw) => bootstrapEnvelope.parse(raw),
      { version: 0.5, snapshot },
      false,
    ],
    [
      "a bootstrap with a broken snapshot",
      (raw) => bootstrapEnvelope.parse(raw),
      { version: 0, snapshot: {} },
      false,
    ],
  ];
  const wrong = cases.filter(([, read, raw, takes]) => {
    try {
      read(raw);
      return !takes;
    } catch {
      return takes;
    }
  });
  expect(wrong.map(([name]) => name)).toEqual([]);
});

test("a snapshot keeps the app's own fields beside the stream and revision", () => {
  expect(snapshotEnvelope.parse(snapshot)).toEqual(snapshot);
  expect(eventEnvelope.parse(event)).toEqual(event);
});
