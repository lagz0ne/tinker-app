import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vite-plus/test";
import { version } from "../../lib/checks/version.mjs";
import { baseDir, basePackage } from "../../lib/paths.mjs";
import { fixture, goodApp } from "../fixture.mjs";

test("passes when the base resolves and every peer is the tested version", () => {
  expect(version(goodApp())).toEqual({
    status: "ok",
    lines: [`@tinker/start ${basePackage.version}; 4 peers match the tested versions`],
  });
});

test("the base is the one in the app's node_modules, never one on NODE_PATH", () => {
  const store = fixture({
    "node_modules/@tinker/start/package.json": JSON.stringify(basePackage),
  });
  const app = fixture({ "package.json": "{}" });
  const check = pathToFileURL(join(baseDir, "lib/checks/version.mjs")).href;
  const script = `const { version } = await import(${JSON.stringify(check)});\nconsole.log(JSON.stringify(version(${JSON.stringify(app)}).lines));`;
  const lines = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, NODE_PATH: join(store, "node_modules") },
    encoding: "utf8",
  });
  expect(JSON.parse(lines)).toEqual([
    "package.json:1 does not install @tinker/start; add it and install",
  ]);
});

test("fails when the base does not resolve", () => {
  expect(version(fixture({ "package.json": "{}" })).lines).toEqual([
    "package.json:1 does not install @tinker/start; add it and install",
  ]);
});

test("names each peer that drifted from the tested version, or is missing, at its package.json line", () => {
  const root = goodApp({
    "package.json": '{\n  "dependencies": {\n    "@tanstack/react-router": "1.0.0"\n  }\n}\n',
    "node_modules/@tanstack/react-router/package.json": JSON.stringify({ version: "1.0.0" }),
    "node_modules/@tinker/react/package.json": "{}",
  });
  const tested = basePackage.tinker.tested;
  expect(version(root)).toMatchObject({
    status: "fail",
    lines: [
      `package.json:3 @tanstack/react-router is 1.0.0, tested with ${tested["@tanstack/react-router"]}`,
      `package.json:1 @tinker/react is missing, tested with ${tested["@tinker/react"]}`,
    ],
  });
});

test("names an exact pin in package.json that the install does not match, at its line", () => {
  const root = goodApp({
    "package.json":
      '{\n  "dependencies": {\n    "@tanstack/react-start": "9.9.9",\n    "react": "^19.0.0",\n    "@tinker/core": "workspace:*"\n  },\n  "devDependencies": {\n    "zod": "4.0.0"\n  }\n}\n',
  });
  expect(version(root).lines).toEqual([
    `package.json:3 pins @tanstack/react-start 9.9.9, but ${basePackage.tinker.tested["@tanstack/react-start"]} is installed; run install`,
    "package.json:8 pins zod 4.0.0, but nothing is installed; run install",
  ]);
});
