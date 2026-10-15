import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { expect, test } from "vite-plus/test";

import { prepare, prepareExitCode, render } from "../lib/prepare.mjs";
import { fixture, goodApp } from "./fixture.mjs";

test("every alias in the generated tsconfig is absolute, so shadcn writes inside the app", () => {
  const root = fixture({ "package.json": "{}" });
  const { paths } = JSON.parse(render(root)["tsconfig.json"]).compilerOptions;
  expect(paths["@/*"]).toEqual([`${root}/src/*`]);
  expect(
    Object.values(paths)
      .flat()
      .every((path) => isAbsolute(path)),
  ).toBe(true);
});

test("the build's tsc checks vite.config.ts too, so a tinker() option type is checked", () => {
  const { include } = JSON.parse(render(fixture({ "package.json": "{}" }))["tsconfig.json"]);
  expect(include).toEqual([
    "../src",
    "../cmds",
    "../tinker",
    "../cmds/router.ts",
    "../cmds/start.ts",
    "../cmds/server.ts",
    "../tests",
    "../vite.config.ts",
    "../vite.config.mts",
    "./routeTree.gen.ts",
  ]);
});

test("prepare writes build isolation, never app wiring", () => {
  const root = goodApp({
    ".tinker/base.json": "old version receipt",
    ".tinker/parts.ts": "old generated runtime",
    ".tinker/parts.server.ts": "old generated runtime",
    ".tinker/telemetry-env.ts": "old generated runtime",
  });
  expect(prepare(root)).toEqual(["tsconfig.json"]);

  const { paths } = JSON.parse(render(root)["tsconfig.json"]).compilerOptions;
  expect(Object.keys(paths)).toEqual(["@/*", "~/*", "#tinker/routes"]);
  expect(paths["#tinker/routes"]).toEqual([join(root, ".tinker/routeTree.gen.ts")]);

  for (const file of ["base.json", "parts.ts", "parts.server.ts", "telemetry-env.ts"]) {
    expect(existsSync(join(root, ".tinker", file))).toBe(false);
  }
});

test("a failing tinker prepare fails, except as postinstall, so a broken clone still installs", () => {
  expect(prepareExitCode(["src/routes/tinker.tsx:2 takes /tinker, a base route"], "build")).toBe(1);
  expect(
    prepareExitCode(["src/routes/tinker.tsx:2 takes /tinker, a base route"], "postinstall"),
  ).toBe(0);
  expect(prepareExitCode([], undefined)).toBe(0);
});

test("prepare has no package defaults or private app aliases", () => {
  const files = render(fixture({ "package.json": "{}" }));
  expect(Object.keys(files)).toEqual(["tsconfig.json"]);
  const { paths } = JSON.parse(files["tsconfig.json"]).compilerOptions;
  expect(Object.keys(paths).filter((key) => key.startsWith("#tinker/"))).toEqual([
    "#tinker/routes",
  ]);
});
