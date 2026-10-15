import { expect, test } from "vite-plus/test";

import { buildChecks } from "../lib/doctor.mjs";
import { basePackage } from "../lib/paths.mjs";
import { goodApp } from "./fixture.mjs";

const runtimeWarning =
  'tinker doctor, import directions: cmds/server.ts:1 "@tinker/start/server" imports the runtime package; use copied base or component entries';

test("the old runtime import warns while the app still builds", () => {
  expect(
    buildChecks(
      goodApp({
        "cmds/server.ts": 'import * as start from "@tinker/start/server";\nexport default 1;',
      }),
    ),
  ).toEqual({ errors: [], warnings: [runtimeWarning] });
});

test("each silent mistake stops the build with doctor's file:line message", () => {
  const root = goodApp({
    ".tinker/base.json": JSON.stringify({ base: "0.8.0", parts: ["auth", "sync"] }),
    "src/router.tsx": "",
    "src/routes/index.tsx": 'export const route = createFileRoute("/")({});\n',
    "src/routes/api.sync/settings.tsx":
      'export const Route = createFileRoute("/api/sync/settings")({});\n',
    "src/routes/__root.tsx":
      "export const Route = createRootRoute({ component: () => <main /> });\n",
    "src/backend/peek.ts": 'import x from "#tinker/routes";\n',
    "src/styles.css": "",
  });
  expect(buildChecks(root).errors).toEqual([
    "tinker doctor, named files: src/router.tsx:1 is a Start file the base does not read; router options and client wiring go in cmds/router.ts",
    'tinker doctor, imports: src/backend/peek.ts:1 "#tinker/routes" is a base-only name; app code cannot import it',
    "tinker doctor, routes: src/routes/index.tsx:1 does not export Route; TanStack skips the file, so / is a 404",
    "tinker doctor, routes: src/routes/__root.tsx:1 sets component without <Outlet />; no page renders inside the shell",
    "tinker doctor, style: src/styles.css:1 is never linked: nothing imports it, and the shell links only src/style.css",
  ]);
});

test("a second tinker() or tanstackStart() stops the build: Start would fail later with no cause", () => {
  const root = goodApp({
    "vite.config.ts":
      'import { tinker } from "@tinker/start/vite";\nexport default { plugins: [tinker({serverEntry:"cmds/server.ts"}), tinker(), tanstackStart()] };\n',
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
      'import { tinker as base } from "@tinker/start/vite";\nexport default { plugins: [base({serverEntry:"cmds/server.ts"})] };\n',
  });
  expect(buildChecks(root)).toEqual({ errors: [], warnings: [] });
});

test("a valid export * in a seam file and a route file builds", () => {
  const root = goodApp({
    "cmds/server.ts": 'export default 1;\nexport * from "@/backend/seam.server";\n',
    "src/backend/seam.server.ts":
      "export const extensions = [];\nexport const settings = () => [];\n",
    "src/routes/about.tsx": 'export * from "../frontend/about";\n',
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

test("with auth on, the main needs only its default export", () => {
  const root = goodApp({
    ".tinker/base.json": JSON.stringify({ base: "0.4.0", parts: ["telemetry", "auth"] }),
    "cmds/server.ts": "export default 1;\n",
  });
  expect(buildChecks(root).errors).toEqual([]);
});

test("a copied sync component with a missing dependency stops the build with its manifest line", () => {
  const root = goodApp({
    "tinker/components/sync/component.json": '{"requires":["missing"]}',
    "tinker/components/sync/index.ts": "export const sync = 1;",
  });
  expect(buildChecks(root).errors).toEqual([
    "tinker doctor, named files: tinker/components/sync/component.json: requires missing component tinker/components/missing; shadcn add it",
  ]);
});
