import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { passThrough } from "../lib/glue.mjs";
import { readPartEnv, rules } from "../lib/part-env.mjs";
import { partNotes, parts, partsOn, recordedParts } from "../lib/parts.mjs";
import { baseDir, basePackage } from "../lib/paths.mjs";
import { fixture } from "./fixture.mjs";

const telemetryEnv = JSON.parse(
  readFileSync(
    join(baseDir, "../../apps/start-scaffold/tinker/components/telemetry/component.json"),
    "utf8",
  ),
).env;

test("telemetry is copied and no longer has a plugin switch", () => {
  expect(partsOn({})).toEqual([]);
  for (const value of [true, false, "off", 0]) {
    expect(() => passThrough({ telemetry: value })).toThrow("tinker(): unknown option telemetry");
  }
});

test("a remaining part switch that is not boolean still fails", () => {
  expect(() => partsOn({ auth: "off" })).toThrow("tinker(): auth takes true or false");
  expect(() => partsOn({ auth: 0 })).toThrow("tinker(): auth takes true or false");
});

test("the copied telemetry env table reads five keys with their same defaults", () => {
  expect(parts.telemetry).toBeUndefined();
  expect(readPartEnv(telemetryEnv, {})).toEqual({
    values: {
      VICTORIA_TRACES_URL: "http://127.0.0.1:10428/insert/opentelemetry/v1/traces",
      VICTORIA_LOGS_URL: "http://127.0.0.1:9428/insert/jsonline",
      OTEL_SERVICE_NAME: "tinker-app",
      LOG_LEVEL: "info",
      SPAN_HISTORY: "80",
    },
    refused: [],
  });
});

test("a set key wins over its default; an empty one reads as unset", () => {
  const { values } = readPartEnv(telemetryEnv, {
    VICTORIA_LOGS_URL: "https://logs.example/insert",
    OTEL_SERVICE_NAME: "",
  });
  expect([values.VICTORIA_LOGS_URL, values.OTEL_SERVICE_NAME]).toEqual([
    "https://logs.example/insert",
    "tinker-app",
  ]);
});

test("a value that breaks its key's rule is refused, every such key at once", () => {
  expect(
    readPartEnv(telemetryEnv, {
      VICTORIA_TRACES_URL: "not a url",
      VICTORIA_LOGS_URL: "ftp://logs.example/insert",
      OTEL_SERVICE_NAME: "any text",
      LOG_LEVEL: "loud",
      SPAN_HISTORY: "-1",
    }).refused,
  ).toEqual(["VICTORIA_TRACES_URL", "VICTORIA_LOGS_URL", "LOG_LEVEL", "SPAN_HISTORY"]);

  expect(rules.level.accepts("warn")).toBe(true);
  expect(rules.count.accepts("0")).toBe(true);
  expect(rules.count.accepts("1.5")).toBe(false);
  expect(rules.count.accepts("9".repeat(400))).toBe(false);

  expect(rules.http.wants).toBe("an http(s) URL");
  expect(rules.http.accepts("xhttp://a.example")).toBe(false);
  expect(rules.http.accepts("http://127.0.0.1:1/x")).toBe(true);
  expect(rules.http.accepts("https://a.example")).toBe(true);
});

test("the record of the last tinker() call names the parts that are on", () => {
  const root = fixture({ ".tinker/base.json": JSON.stringify({ base: "0.3.0", parts: [] }) });
  expect(recordedParts(root)).toEqual([]);
});

test("no record, an unreadable one, or one from before parts reads as the defaults", () => {
  expect(recordedParts(fixture({}))).toEqual([]);
  expect(recordedParts(fixture({ ".tinker/base.json": "{" }))).toEqual([]);
  expect(recordedParts(fixture({ ".tinker/base.json": '{ "base": "0.2.0" }' }))).toEqual([]);
});

test("a recorded part this base does not have is left out", () => {
  const root = fixture({
    ".tinker/base.json": JSON.stringify({ base: "9.0.0", parts: ["telemetry", "later"] }),
  });
  expect(recordedParts(root)).toEqual([]);
  expect(Object.keys(basePackage.tinker.parts)).toEqual(["auth", "sync"]);
});

test("auth is off by default, and tinker({ auth: true }) turns it on", () => {
  expect(partsOn({ telemetry: false })).toEqual([]);
  expect(partsOn({ auth: true })).toEqual(["auth"]);
  expect(partsOn({ telemetry: false, auth: true })).toEqual(["auth"]);
  expect(() => partsOn({ auth: "yes" })).toThrow("tinker(): auth takes true or false");
});

test("the legacy auth switch mounts no route and still checks its two keys", () => {
  expect(parts.auth.routes).toEqual({});
  expect(parts.auth.reads).toBeUndefined();
  expect(readPartEnv(parts.auth.env, {})).toEqual({
    values: { PUBLIC_ORIGIN: undefined, AUTH_SECRET: undefined },
    refused: ["PUBLIC_ORIGIN", "AUTH_SECRET"],
  });
  const secret = "s".repeat(32);
  expect(
    readPartEnv(parts.auth.env, { PUBLIC_ORIGIN: "http://localhost:4318", AUTH_SECRET: secret }),
  ).toEqual({
    values: { PUBLIC_ORIGIN: "http://localhost:4318", AUTH_SECRET: secret },
    refused: [],
  });
});

test("a secret takes at least 32 characters", () => {
  expect(rules.secret.wants).toBe("at least 32 characters");
  expect(rules.secret.accepts("s".repeat(31))).toBe(false);
  expect(rules.secret.accepts("s".repeat(32))).toBe(true);
});

test("sync is off by default; on, it turns auth on, and says so", () => {
  expect(partsOn({})).toEqual([]);
  expect(partsOn({ sync: true })).toEqual(["auth", "sync"]);
  expect(partsOn({ sync: true, auth: true, telemetry: false })).toEqual(["auth", "sync"]);
  expect(partNotes(["auth", "sync"])).toEqual(["sync turns auth on"]);
  expect(partNotes(["auth"])).toEqual([]);
});

test("sync with auth: false fails the build with the two ways out", () => {
  expect(() => partsOn({ sync: true, auth: false })).toThrow(
    "tinker(): sync needs auth, but auth is false; drop auth: false, or set sync: false",
  );
  expect(partsOn({ sync: false, auth: false })).toEqual([]);
});

test("the sync part mounts /api/sync, reads the router seam and the Register bodies, and no env key", () => {
  expect(parts.sync.routes).toEqual({ "/api/sync": "src/routes/api.sync.ts" });
  expect(parts.sync.reads).toEqual({
    "#tinker/router": ["records", "readSnapshot", "readBootstrap", "readBatch", "streamMessage"],
  });
  expect(parts.sync.augments).toEqual({ "@tinker/start": ["Register"] });
  expect(readPartEnv(parts.sync.env, {})).toEqual({ values: {}, refused: [] });
});
