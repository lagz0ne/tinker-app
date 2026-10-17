import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { passThrough } from "../lib/glue.mjs";
import { baseDir, basePackage } from "../lib/paths.mjs";

test("telemetry is copied and no longer has a plugin switch", () => {
  for (const value of [true, false, "off", 0]) {
    expect(() => passThrough({ telemetry: value })).toThrow("tinker(): unknown option telemetry");
  }
});

test.each(["auth", "sync", "telemetry"])(
  "%s has no plugin switch or package runtime export",
  (name) => {
    for (const value of [true, false, "off", 0]) {
      expect(() => passThrough({ [name]: value })).toThrow(`tinker(): unknown option ${name}`);
    }
    expect(Object.keys(basePackage.exports)).toEqual(["./vite", "./package.json", "./main-host"]);
    expect(basePackage.files).not.toContain("src");
  },
);

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
  expect(basePackage).not.toHaveProperty("tinker");
  expect(manifest).toEqual({ requires: ["errors", "requests", "database"] });
});
