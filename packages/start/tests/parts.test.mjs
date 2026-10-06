import { expect, test } from "vite-plus/test";
import { readPartEnv, rules } from "../lib/part-env.mjs";
import { parts, partsOn, recordedParts } from "../lib/parts.mjs";
import { basePackage } from "../lib/paths.mjs";
import { fixture } from "./fixture.mjs";

test("telemetry is on by default, and tinker({ telemetry: false }) turns it off", () => {
  expect(partsOn({})).toEqual(["telemetry"]);
  expect(partsOn({ telemetry: undefined })).toEqual(["telemetry"]);
  expect(partsOn({ telemetry: true, spa: { enabled: true } })).toEqual(["telemetry"]);
  expect(partsOn({ telemetry: false })).toEqual([]);
});

test("a part switch that is not true or false fails the build", () => {
  expect(() => partsOn({ telemetry: "off" })).toThrow("tinker(): telemetry takes true or false");
  expect(() => partsOn({ telemetry: 0 })).toThrow("tinker(): telemetry takes true or false");
});

test("the telemetry part mounts /api/telemetry and reads three keys, each with a default", () => {
  expect(parts.telemetry.routes).toEqual({ "/api/telemetry": "src/routes/api.telemetry.ts" });
  expect(readPartEnv(parts.telemetry.env, {})).toEqual({
    values: {
      VICTORIA_TRACES_URL: "http://127.0.0.1:10428/insert/opentelemetry/v1/traces",
      VICTORIA_LOGS_URL: "http://127.0.0.1:9428/insert/jsonline",
      OTEL_SERVICE_NAME: "tinker-app",
    },
    refused: [],
  });
});

test("a set key wins over its default; an empty one reads as unset", () => {
  const { values } = readPartEnv(parts.telemetry.env, {
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
    readPartEnv(parts.telemetry.env, {
      VICTORIA_TRACES_URL: "not a url",
      VICTORIA_LOGS_URL: "ftp://logs.example/insert",
      OTEL_SERVICE_NAME: "any text",
    }).refused,
  ).toEqual(["VICTORIA_TRACES_URL", "VICTORIA_LOGS_URL"]);
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
  expect(recordedParts(fixture({}))).toEqual(["telemetry"]);
  expect(recordedParts(fixture({ ".tinker/base.json": "{" }))).toEqual(["telemetry"]);
  expect(recordedParts(fixture({ ".tinker/base.json": '{ "base": "0.2.0" }' }))).toEqual([
    "telemetry",
  ]);
});

test("a recorded part this base does not have is left out", () => {
  const root = fixture({
    ".tinker/base.json": JSON.stringify({ base: "9.0.0", parts: ["telemetry", "later"] }),
  });
  expect(recordedParts(root)).toEqual(["telemetry"]);
  expect(Object.keys(basePackage.tinker.parts)).toEqual(["telemetry", "auth"]);
});

test("auth is off by default, and tinker({ auth: true }) turns it on", () => {
  expect(partsOn({ telemetry: false })).toEqual([]);
  expect(partsOn({ auth: true })).toEqual(["telemetry", "auth"]);
  expect(partsOn({ telemetry: false, auth: true })).toEqual(["auth"]);
  expect(() => partsOn({ auth: "yes" })).toThrow("tinker(): auth takes true or false");
});

test("the auth part mounts /api/auth/$, reads the server seam, and two keys with no default", () => {
  expect(parts.auth.routes).toEqual({ "/api/auth/$": "src/routes/api.auth.ts" });
  expect(parts.auth.reads).toEqual({ "src/lib/tinker.server.ts": ["auth", "readAccount"] });
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
