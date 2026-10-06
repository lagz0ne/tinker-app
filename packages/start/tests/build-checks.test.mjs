import { expect, test } from "vite-plus/test";
import { buildChecks } from "../lib/doctor.mjs";
import { basePackage } from "../lib/paths.mjs";
import { goodApp } from "./fixture.mjs";

test("a good app builds with no error and no warning", () => {
  expect(buildChecks(goodApp())).toEqual({ errors: [], warnings: [] });
});

test("each silent mistake stops the build with doctor's file:line message", () => {
  const root = goodApp({
    "src/router.tsx": "",
    "src/routes/index.tsx": 'export const route = createFileRoute("/")({});\n',
    "src/routes/tinker/settings.tsx":
      'export const Route = createFileRoute("/tinker/settings")({});\n',
    "src/routes/__root.tsx":
      "export const Route = createRootRoute({ component: () => <main /> });\n",
    "src/backend/peek.ts": 'import x from "#tinker/routes";\n',
    "src/styles.css": "",
  });
  expect(buildChecks(root).errors).toEqual([
    "tinker doctor, named files: src/router.tsx:1 is a Start file the base does not read; router options go in src/router.ts",
    'tinker doctor, imports: src/backend/peek.ts:1 "#tinker/routes" is a base-only name; app code cannot import it',
    "tinker doctor, routes: src/routes/index.tsx:1 does not export Route; TanStack skips the file, so / is a 404",
    "tinker doctor, routes: src/routes/tinker/settings.tsx:1 nests under /tinker, a base route with no outlet; the base page renders",
    "tinker doctor, routes: src/routes/__root.tsx:1 sets component without <Outlet />; no page renders inside the shell",
    "tinker doctor, style: src/styles.css:1 is never linked: nothing imports it, and the shell links only src/style.css",
  ]);
});

test("a second tinker() or tanstackStart() stops the build: Start would fail later with no cause", () => {
  const root = goodApp({
    "vite.config.ts":
      'import { tinker } from "@tinker/start/vite";\nexport default { plugins: [tinker(), tinker(), tanstackStart()] };\n',
  });
  expect(buildChecks(root)).toEqual({
    errors: [
      "tinker doctor, glue: vite.config.ts:2 calls tinker() 2 times; call it once: plugins: [tinker()]",
      "tinker doctor, glue: vite.config.ts:2 adds tanstackStart(); tinker() adds it already",
    ],
    warnings: [],
  });
});

test("a components.json that does not parse stops the build with its line", () => {
  const root = goodApp({ "components.json": "{ nope" });
  expect(buildChecks(root).errors).toEqual([
    "tinker doctor, style: components.json:1 does not parse (InvalidSymbol)",
  ]);
});

test("tinker() imported under another name, and called once, builds", () => {
  const root = goodApp({
    "vite.config.ts":
      'import { tinker as base } from "@tinker/start/vite";\nexport default { plugins: [base()] };\n',
  });
  expect(buildChecks(root)).toEqual({ errors: [], warnings: [] });
});

test("a valid export * in a seam file and a route file builds", () => {
  const root = goodApp({
    "src/lib/tinker.server.ts": 'export * from "../backend/seam.server.ts";\n',
    "src/backend/seam.server.ts": "export const extensions = [];\n",
    "src/routes/about.tsx": 'export * from "../frontend/about.tsx";\n',
    "src/frontend/about.tsx": 'export const Route = createFileRoute("/about")({});\n',
  });
  expect(buildChecks(root)).toEqual({ errors: [], warnings: [] });
});

test("a glue or version problem only warns: the build itself still works", () => {
  const root = goodApp({
    "tsconfig.json": "{}",
    "node_modules/@tanstack/react-start/package.json": JSON.stringify({ version: "0.0.1" }),
  });
  const { errors, warnings } = buildChecks(root);
  expect(errors).toEqual([]);
  expect(warnings).toEqual([
    `tinker doctor, base version: package.json:1 @tanstack/react-start is 0.0.1, tested with ${basePackage.tinker.tested["@tanstack/react-start"]}`,
    'tinker doctor, glue: tsconfig.json:1 does not extend "./.tinker/tsconfig.json"',
  ]);
});

test("with auth on, a seam without readAccount stops the build with doctor's line", () => {
  const root = goodApp({
    ".tinker/base.json": JSON.stringify({ base: "0.4.0", parts: ["telemetry", "auth"] }),
    "src/lib/tinker.server.ts": "export const extensions = [];\nexport const auth = 1;\n",
  });
  expect(buildChecks(root).errors).toEqual([
    "tinker doctor, named files: src/lib/tinker.server.ts:1 does not export readAccount; the auth part reads it",
  ]);
});
