import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { expect, test } from "vite-plus/test";
import { baseDir, basePackage } from "../lib/paths.mjs";
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
    "../tests",
    "../vite.config.ts",
    "../vite.config.mts",
    "./routeTree.gen.ts",
  ]);
});

test("a named file the app has wins; a missing one maps to the base default", () => {
  const root = goodApp({
    "src/router.ts": "export const router = () => ({});\n",
    "src/lib/tinker.server.ts": "export const extensions = [];\n",
  });
  const { paths } = JSON.parse(render(root)["tsconfig.json"]).compilerOptions;
  expect(paths["#tinker/router"]).toEqual([join(root, "src/router.ts")]);
  expect(paths["#tinker/app.server"]).toEqual([join(root, "src/lib/tinker.server.ts")]);
  expect(paths["#tinker/start"]).toEqual([
    join(root, "node_modules/@tinker/start/src/defaults/start.ts"),
  ]);
  expect(paths["#tinker/routes"]).toEqual([join(root, ".tinker/routeTree.gen.ts")]);
});

test("prepare writes the tsconfig, the parts files, and the base version into .tinker/", () => {
  const root = fixture({ "package.json": "{}" });
  expect(prepare(root)).toEqual(["tsconfig.json", "base.json", "parts.ts", "parts.server.ts"]);
  expect(JSON.parse(readFileSync(join(root, ".tinker/base.json"), "utf8"))).toEqual({
    base: basePackage.version,
    parts: ["telemetry"],
  });
  expect(existsSync(join(root, ".tinker/tsconfig.json"))).toBe(true);
});

test("each parts file exports every part, from its on or its off module", () => {
  const root = fixture({ "package.json": "{}" });
  const module = (file) => JSON.stringify(join(baseDir, "src/parts/telemetry", file));
  const on = render(root, ["telemetry"]);
  expect(on["parts.ts"]).toBe(
    `// Written by tinker(); parts on: telemetry.\nexport { telemetry } from ${module("on.ts")};\n`,
  );
  expect(on["parts.server.ts"]).toBe(
    `// Written by tinker(); parts on: telemetry.\nexport { telemetry } from ${module("on.server.ts")};\n`,
  );
  const off = render(root, []);
  expect(off["parts.ts"]).toBe(
    `// Written by tinker(); parts on: none.\nexport { telemetry } from ${module("off.ts")};\n`,
  );
  expect(off["parts.server.ts"]).toBe(off["parts.ts"]);
});

test("tinker prepare with no options keeps the parts the last tinker() call recorded", () => {
  const root = fixture({ "package.json": "{}" });
  prepare(root, []);
  expect(prepare(root)).toContain("parts.ts");
  expect(JSON.parse(readFileSync(join(root, ".tinker/base.json"), "utf8")).parts).toEqual([]);
  expect(readFileSync(join(root, ".tinker/parts.ts"), "utf8")).toContain("off.ts");
});

test("the generated tsconfig maps both parts files", () => {
  const root = fixture({ "package.json": "{}" });
  const { paths } = JSON.parse(render(root)["tsconfig.json"]).compilerOptions;
  expect(paths["#tinker/parts"]).toEqual([join(root, ".tinker/parts.ts")]);
  expect(paths["#tinker/parts.server"]).toEqual([join(root, ".tinker/parts.server.ts")]);
});

test("a failing tinker prepare fails, except as postinstall, so a broken clone still installs", () => {
  expect(prepareExitCode(["src/routes/tinker.tsx:2 takes /tinker, a base route"], "build")).toBe(1);
  expect(
    prepareExitCode(["src/routes/tinker.tsx:2 takes /tinker, a base route"], "postinstall"),
  ).toBe(0);
  expect(prepareExitCode([], undefined)).toBe(0);
});
