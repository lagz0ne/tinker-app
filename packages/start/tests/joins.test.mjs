import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { doctor } from "../lib/doctor.mjs";
import { aliases } from "../lib/glue.mjs";
import { restartNote } from "../lib/hooks.mjs";
import { prepare, render } from "../lib/prepare.mjs";
import { goodApp, write } from "./fixture.mjs";

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
  expect(server).toContain("return [join0.settings(env), join1.settings(env), own.settings(env)];");
  expect(server).toContain('export { database } from "@/joins/postgres.join.server";');
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
