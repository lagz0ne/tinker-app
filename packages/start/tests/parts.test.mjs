import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { passThrough } from "../lib/glue.mjs";
import { readPartEnv, rules } from "../lib/part-env.mjs";
import { baseDir, basePackage } from "../lib/paths.mjs";

const telemetryEnv = JSON.parse(
  readFileSync(
    join(baseDir, "../../apps/start-scaffold/tinker/components/telemetry/component.json"),
    "utf8",
  ),
).env;

test("telemetry is copied and no longer has a plugin switch", () => {
  for (const value of [true, false, "off", 0]) {
    expect(() => passThrough({ telemetry: value })).toThrow("tinker(): unknown option telemetry");
  }
});

test("the copied telemetry env table reads five keys with their same defaults", () => {
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

test.each(["auth", "sync", "telemetry"])(
  "%s has no plugin switch or package runtime export",
  (name) => {
    for (const value of [true, false, "off", 0]) {
      expect(() => passThrough({ [name]: value })).toThrow(`tinker(): unknown option ${name}`);
    }
    expect(Object.keys(basePackage.exports)).toEqual(["./vite", "./package.json"]);
    expect(basePackage.files).not.toContain("src");
  },
);

test("copied auth checks its two required env keys from JSON", () => {
  const env = JSON.parse(
    readFileSync(
      join(baseDir, "../../apps/start-scaffold/tinker/components/auth/component.json"),
      "utf8",
    ),
  ).env;
  expect(readPartEnv(env, {})).toEqual({
    values: { PUBLIC_ORIGIN: undefined, AUTH_SECRET: undefined },
    refused: ["PUBLIC_ORIGIN", "AUTH_SECRET"],
  });
  expect(
    readPartEnv(env, { PUBLIC_ORIGIN: "http://localhost:4318", AUTH_SECRET: "s".repeat(32) })
      .refused,
  ).toEqual([]);
});

test("a secret takes at least 32 characters", () => {
  expect(rules.secret.wants).toBe("at least 32 characters");
  expect(rules.secret.accepts("s".repeat(31))).toBe(false);
  expect(rules.secret.accepts("s".repeat(32))).toBe(true);
});

test("copied sync has no switch or generated activation note", () => {
  expect(() => passThrough({ sync: true })).toThrow("tinker(): unknown option sync");
});

test("sync cannot be toggled off or paired with an auth switch", () => {
  for (const sync of [false, true]) {
    expect(() => passThrough({ sync, auth: false })).toThrow("tinker(): unknown option sync");
  }
});

test("copied sync declares its direct dependencies and owns no env table", () => {
  const manifest = JSON.parse(
    readFileSync(
      join(baseDir, "../../apps/start-scaffold/tinker/components/sync/component.json"),
      "utf8",
    ),
  );
  expect(basePackage.tinker).not.toHaveProperty("parts");
  expect(manifest).toEqual({ requires: ["errors", "requests", "auth", "database"] });
});
