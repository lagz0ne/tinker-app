import { readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vite-plus/test";

import { doctor } from "../lib/doctor.mjs";
import { aliases } from "../lib/glue.mjs";
import { restartNote } from "../lib/hooks.mjs";
import { prepare, render } from "../lib/prepare.mjs";
import { checkTypes } from "../lib/typecheck.mjs";
import { fixture, goodApp, write } from "./fixture.mjs";

test("prepare joins items in needs order, then the user's seam, without editing it", () => {
  const own = "export const extensions = [];\nexport const settings = () => [];\n";
  const root = goodApp({
    "src/lib/tinker.server.ts": own,
    "src/joins/mail.join.server.ts":
      'export const needs = ["postgres"] as const;\nexport const extensions = [];\nexport const settings = () => [];\n',
    "src/joins/postgres.join.server.ts":
      "export const needs = [] as const;\nexport const database = {};\nexport const settings = () => [];\n",
    "src/joins/mail.join.ts": "export const needs = [] as const;\nexport const extensions = [];\n",
  });

  const files = render(root);
  prepare(root);

  const server = files["app.server.ts"];
  expect(server).toContain('import * as join0 from "@/joins/postgres.join.server";');
  expect(server).toContain('import * as join1 from "@/joins/mail.join.server";');
  expect(server).toContain(
    "export const extensions = [join1.extensions, own.extensions] as const;",
  );
  expect(server).toContain("return [join0Settings(env), join1Settings(env), ownSettings(env)];");
  expect(server).toContain('export { database } from "@/joins/postgres.join.server";');
  expect(readFileSync(join(root, "src/lib/tinker.server.ts"), "utf8")).toBe(own);
  expect(files["app.ts"]).not.toContain(".join.server");
  expect(JSON.parse(files["tsconfig.json"]).compilerOptions.paths["#tinker/app.server"]).toEqual([
    join(root, ".tinker/app.server.ts"),
  ]);
  expect(aliases(root).find(({ find }) => find.test("#tinker/app")).replacement).toBe(
    `${join(root, ".tinker/app.ts")}$1`,
  );
});

test("two joins owning database fail prepare and doctor with both file names, even with a user owner", () => {
  const root = goodApp({
    "src/lib/tinker.server.ts":
      "export const extensions = [];\nexport const settings = () => [];\nexport const database = {};\n",
  });
  prepare(root);
  write(root, {
    ".tinker/routeTree.gen.ts": "import { Route } from './../src/routes/index'\n",
    "src/joins/first.join.server.ts":
      "export const needs = [] as const;\nexport const database = {};\n",
    "src/joins/second.join.server.ts":
      "export const needs = [] as const;\nexport const database = {};\n",
  });

  expect(() => prepare(root)).toThrow(
    "database: src/joins/first.join.server.ts and src/joins/second.join.server.ts",
  );
  const checked = doctor(root, false);

  expect(checked.code).toBe(1);
  expect(checked.lines.join("\n").replaceAll(/\s+/g, " ")).toContain(
    "database: src/joins/first.join.server.ts and src/joins/second.join.server.ts",
  );
});

test("a new join file makes dev restart and unrelated files do not", () => {
  expect(restartNote("/app", "/app/src/joins/mail.join.server.ts", "added")).toBe(
    "tinker: src/joins/mail.join.server.ts added; restarting",
  );
  expect(restartNote("/app", "/app/src/joins/mail.join.ts", "removed")).toBe(
    "tinker: src/joins/mail.join.ts removed; restarting",
  );
  expect(restartNote("/app", "/app/src/joins/readme.ts", "added")).toBeNull();
});

test("the user's single names win and a dependency with no join adds no list", () => {
  const root = goodApp({
    "src/lib/tinker.server.ts":
      "export const extensions = [];\nexport const settings = () => [];\nexport const database = {};\n",
    "src/joins/postgres.join.server.ts":
      'export const needs = ["errors"] as const;\nexport const database = {};\n',
  });

  const server = render(root)["app.server.ts"];

  expect(server).toContain('export { database } from "@/lib/tinker.server";');
});

test("prepare refuses a needs cycle and a nonliteral needs list", () => {
  const root = goodApp({
    "src/joins/mail.join.ts": 'export const needs = ["auth"] as const;\n',
    "src/joins/auth.join.ts": 'export const needs = ["mail"] as const;\n',
  });

  expect(() => prepare(root)).toThrow(
    "join needs cycle: src/joins/auth.join.ts and src/joins/mail.join.ts",
  );
  write(root, { "src/joins/auth.join.ts": "export const needs = getNeeds();\n" });

  expect(() => prepare(root)).toThrow(
    "src/joins/auth.join.ts: needs must be an exported literal list",
  );
});

/** The app's real peers let tsc check generated joins without booting a framework. */
function typedApp(files) {
  const root = fixture({
    "package.json": "{}",
    "tsconfig.json": JSON.stringify({ extends: "./.tinker/tsconfig.json" }),
    "src/lib/tinker.server.ts":
      "export const extensions = [];\nexport const settings = () => [];\n",
    "src/lib/tinker.ts": "export const extensions = [];\n",
    ...files,
  });
  symlinkSync(
    fileURLToPath(new URL("../../../apps/start-min/node_modules", import.meta.url)),
    join(root, "node_modules"),
  );
  prepare(root);
  return root;
}

test("tsc rejects wrong settings bindings and a single name even with its part off", () => {
  const root = typedApp({
    "src/joins/mail.join.server.ts":
      "export const needs = [] as const;\nexport const settings = () => [42];\n",
    "src/joins/postgres.join.server.ts":
      "export const needs = [] as const;\nexport const database = 42;\n",
  });

  const errors = checkTypes(root).join("\n");

  expect(errors).toContain("settings");
  expect(errors).toContain("database");
}, 20000);

test("tsc keeps tag values and the sync change union exact through the generated seam", () => {
  const root = typedApp({
    "src/joins/mail.join.server.ts":
      'import { tag } from "@tinker/core";\nexport const needs = [] as const;\nconst smtpUrl = tag<URL>({ label: "mail.smtpUrl" });\nexport const settings = () => [smtpUrl(new URL("smtp://mail"))];\n',
    "src/joins/sync.join.ts":
      'import { z } from "zod";\nexport const needs = [] as const;\nexport const readBatch = z.object({ version: z.number(), events: z.array(z.object({ stream: z.string(), revision: z.number(), executionId: z.string(), payload: z.object({ kind: z.literal("change"), change: z.object({ kind: z.literal("counter"), value: z.number() }) }) })) });\n',
    "src/check.ts":
      'import { readBatch } from "#tinker/app";\nexport const change: ReturnType<typeof readBatch.parse>["events"][number]["payload"]["change"] = { kind: "counter", value: 1 };\n',
  });

  expect(checkTypes(root)).toEqual([]);
  write(root, {
    "src/joins/mail.join.server.ts":
      'import { tag } from "@tinker/core";\nexport const needs = [] as const;\nconst smtpUrl = tag<URL>({ label: "mail.smtpUrl" });\nexport const settings = () => [smtpUrl("not-a-url")];\n',
    "src/check.ts":
      'import { readBatch } from "#tinker/app";\nexport const change: ReturnType<typeof readBatch.parse>["events"][number]["payload"]["change"] = { kind: "nope", value: 1 };\n',
  });

  const errors = checkTypes(root).join("\n");
  expect(errors).toContain("TS2345");
  expect(errors).toContain("TS2322");
}, 20000);

test("joins accept the server operations and client resources the parts read", () => {
  const root = typedApp({
    "src/joins/auth.join.server.ts": `import { operation, resource } from "@tinker/core";
export const needs = [] as const;
export const readAccount = operation({ label: "account", run: () => null });
export const bootstrap = operation({ label: "bootstrap", run: () => ({ public: { stream: "public" as const, revision: 0 }, private: null }) });
export const auth = resource({ label: "auth", factory: () => ({ handler: async () => new Response(), api: { getSession: async () => null } }) });
`,
    "src/joins/sync.join.ts": `import { resource } from "@tinker/core";
import type { Sync } from "@tinker/start";
export const needs = [] as const;
export const records = resource({ label: "records", factory: (): Sync.Records => ({ resetPrivate() {}, bootstrapPublic() {}, bootstrapPrivate() {}, change() {}, snapshot: () => ({ public: { stream: "public", revision: 0 }, private: null }) }) });
`,
    ".tinker/routeTree.gen.ts":
      'import { createRootRoute } from "@tanstack/react-router";\nexport const routeTree = createRootRoute();\n',
  });

  const errors = checkTypes(root);

  expect(errors).toEqual([]);
}, 20000);

test("a user's alias star export still wins over a join owner", () => {
  const root = goodApp({
    "src/lib/tinker.server.ts": 'export * from "@/backend/own.server";\n',
    "src/backend/own.server.ts":
      "export const extensions = [];\nexport const settings = () => [];\nexport const database = {};\n",
    "src/joins/postgres.join.server.ts":
      "export const needs = [] as const;\nexport const database = {};\n",
  });

  const server = render(root)["app.server.ts"];

  expect(server).toContain('export { database } from "@/lib/tinker.server";');
  expect(server).toContain("ownSettings(env)");
});
