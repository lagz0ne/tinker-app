import { expect, test } from "vite-plus/test";
import { named } from "../../lib/checks/named.mjs";
import { goodApp } from "../fixture.mjs";

test("passes with no named files: the base defaults are in use", () => {
  expect(named(goodApp())).toEqual({
    status: "ok",
    lines: ["no named or seam files; the base defaults are in use"],
  });
});

test("passes when each named and seam file exports what the base reads", () => {
  const root = goodApp({
    "src/router.ts": "export const router = () => ({});\n",
    "src/start.ts": "export const startInstance = createStart(() => ({}));\n",
    "src/server.ts": "export default createServerEntry({ fetch: (r, next) => next(r) });\n",
    "src/lib/tinker.ts": "const extensions = [];\nexport { extensions };\n",
    "src/lib/tinker.server.ts": "export function extensions() {}\n",
  });
  expect(named(root).lines).toEqual([
    "each named or seam file exports what the base reads (src/router.ts, src/start.ts, src/server.ts, src/lib/tinker.ts, src/lib/tinker.server.ts); no Start file is ignored",
  ]);
});

test("names each named or seam file that lacks the export the base imports", () => {
  const root = goodApp({
    "src/router.ts": "export const options = {};\n",
    "src/start.ts": "export const start = 1;\n",
    "src/server.ts": "export const fetch = 1;\n",
    "src/lib/tinker.ts": "export const ext = [];\n",
  });
  expect(named(root).lines).toEqual([
    "src/router.ts:1 does not export router; the base imports it from this file",
    "src/start.ts:1 does not export startInstance; the base imports it from this file",
    "src/server.ts:1 does not export default; the base imports it from this file",
    "src/lib/tinker.ts:1 does not export extensions; the base imports it from this file",
  ]);
});

test("follows export * to a local file, and skips the check when it cannot follow", () => {
  const followed = goodApp({
    "src/lib/tinker.server.ts": 'export * from "../backend/seam.server.ts";\n',
    "src/backend/seam.server.ts": "export const extensions = [];\nexport default 1;\n",
    "src/server.ts": 'export * from "./backend/seam.server.ts";\n',
  });
  expect(named(followed).lines).toEqual([
    "src/server.ts:1 does not export default; the base imports it from this file",
  ]);
  const unread = goodApp({ "src/lib/tinker.server.ts": 'export * from "some-package";\n' });
  expect(named(unread).status).toBe("ok");
});

test("names each usual Start file the glue never reads", () => {
  const root = goodApp({
    "src/router.tsx": "",
    "src/start.tsx": "",
    "src/server.js": "",
    "src/client.tsx": "",
    "src/routeTree.gen.ts": "",
  });
  expect(named(root).lines).toEqual([
    "src/router.tsx:1 is a Start file the base does not read; router options go in src/router.ts",
    "src/start.tsx:1 is a Start file the base does not read; global middleware and defaultSsr go in src/start.ts",
    "src/server.js:1 is a Start file the base does not read; a custom server entry goes in src/server.ts",
    "src/client.tsx:1 is a Start file the base does not read; the base owns the client entry; client extensions go in src/lib/tinker.ts",
    "src/routeTree.gen.ts:1 is a Start file the base does not read; the route tree is .tinker/routeTree.gen.ts; delete this file",
  ]);
});

const authOn = JSON.stringify({ base: "0.4.0", parts: ["telemetry", "auth"] });

test("with auth on, a missing server seam names the file and what the part reads", () => {
  expect(named(goodApp({ ".tinker/base.json": authOn })).lines).toEqual([
    "src/lib/tinker.server.ts is missing; the auth part reads auth and readAccount from it",
  ]);
});

test("with auth on, a seam without auth or readAccount names each missing name", () => {
  const root = goodApp({
    ".tinker/base.json": authOn,
    "src/lib/tinker.server.ts": "export const extensions = [];\nexport const session = 1;\n",
  });
  expect(named(root).lines).toEqual([
    "src/lib/tinker.server.ts:1 does not export auth; the auth part reads it",
    "src/lib/tinker.server.ts:1 does not export readAccount; the auth part reads it",
  ]);
});

test("with auth on, a seam with both names passes; with auth off, none is needed", () => {
  const seam = {
    "src/lib/tinker.server.ts":
      'export const extensions = [];\nexport { auth, readAccount } from "../backend/auth.ts";\n',
    "src/backend/auth.ts": "export const auth = 1;\nexport const readAccount = 2;\n",
  };
  expect(named(goodApp({ ".tinker/base.json": authOn, ...seam })).status).toBe("ok");
  expect(named(goodApp()).status).toBe("ok");
});

const syncOn = JSON.stringify({ base: "0.5.0", parts: ["telemetry", "auth", "sync"] });

test("with sync on, a seam without database names it for the sync part", () => {
  const root = goodApp({
    ".tinker/base.json": syncOn,
    "src/lib/tinker.server.ts":
      "export const extensions = [];\nexport const auth = 1;\nexport const readAccount = 2;\n",
  });
  expect(named(root).lines).toEqual([
    "src/lib/tinker.server.ts:1 does not export database; the sync part reads it",
  ]);
});

test("with sync on and no seam, each part names what it reads", () => {
  expect(named(goodApp({ ".tinker/base.json": syncOn })).lines).toEqual([
    "src/lib/tinker.server.ts is missing; the auth part reads auth and readAccount from it",
    "src/lib/tinker.server.ts is missing; the sync part reads database from it",
  ]);
});
