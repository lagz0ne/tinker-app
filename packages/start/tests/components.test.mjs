import { expect, test } from "vite-plus/test";

import { glue } from "../lib/checks/glue.mjs";
import { imports, commandImport } from "../lib/checks/imports.mjs";
import { named } from "../lib/checks/named.mjs";
import { render } from "../lib/prepare.mjs";
import { goodApp, write } from "./fixture.mjs";

test("components keep src and commands out, through aliases and relative paths", () => {
  const root = goodApp({
    "tinker/components/mail/component.json": '{"requires":[]}',
    "tinker/components/mail/index.ts": 'import "@/user";\nexport * from "../../../cmds/server";',
    "src/user.ts": 'import "../cmds/server";',
  });

  expect(imports(root).lines).toEqual([
    'src/user.ts:1 "../cmds/server" imports a command; src must not import cmds',
    'tinker/components/mail/index.ts:1 "@/user" imports user code; components must not import src',
    'tinker/components/mail/index.ts:2 "../../../cmds/server" imports a command; components must not import cmds',
  ]);
});

test("component public entries and direct requires apply to all source zones", () => {
  const root = goodApp({
    "tinker/components/mail/component.json": '{"requires":[]}',
    "tinker/components/mail/index.ts": 'export * from "~/components/db";',
    "tinker/components/db/component.json": '{"requires":[]}',
    "tinker/components/db/index.ts": "export const value = 1;",
    "src/user.ts": 'import "~/components/db/private";',
  });

  expect(imports(root).lines).toEqual([
    'src/user.ts:1 "~/components/db/private" is private to component db; use "~/components/db"',
    'tinker/components/mail/index.ts:1 "~/components/db" needs "db" in tinker/components/mail/component.json requires',
  ]);
});

test("doctor names component manifests and unknown keys without choosing wiring order", () => {
  const root = goodApp({
    "tinker/components/mail/index.ts": "export const value = 1;",
    "tinker/components/db/component.json": '{"requires":[],"order":1}',
    "tinker/components/db/index.ts": "export const value = 2;",
  });

  expect(named(root).lines).toEqual([
    'tinker/components/db/component.json: unknown key "order"; only requires is allowed',
    'tinker/components/mail: missing component.json; add tinker/components/mail/component.json with { "requires": [] }',
  ]);
});

test("generated tsconfig includes command and component files with the base alias", () => {
  const root = goodApp();
  const glue = JSON.parse(render(root)["tsconfig.json"]);

  expect(glue.include).toContain("../cmds");
  expect(glue.include).toContain("../tinker");
  expect(glue.compilerOptions.paths["~/*"]).toEqual([`${root}/tinker/*`]);
});

test("a component with only a nested helper still needs its manifest", () => {
  const root = goodApp({ "tinker/components/mail/backend/send.ts": "export const value = 1;" });

  expect(named(root).lines).toEqual([
    'tinker/components/mail: missing component.json; add tinker/components/mail/component.json with { "requires": [] }',
  ]);
});

test("the app can name both aliases while keeping every generated private alias", () => {
  const root = goodApp();
  const paths = JSON.parse(render(root)["tsconfig.json"]).compilerOptions.paths;
  write(root, {
    "tsconfig.json": JSON.stringify({
      extends: "./.tinker/tsconfig.json",
      compilerOptions: { paths },
    }),
  });

  expect(glue(root).status).toBe("ok");
});

test("absolute paths obey the command and component boundaries too", () => {
  const root = goodApp({ "tinker/components/mail/component.json": '{"requires":[]}' });
  write(root, {
    "src/user.ts": `import "${root}/cmds/server";`,
    "tinker/components/mail/index.ts": `import "${root}/src/user";`,
  });

  expect(imports(root).lines).toEqual([
    `src/user.ts:1 "${root}/cmds/server" imports a command; src must not import cmds`,
    `tinker/components/mail/index.ts:1 "${root}/src/user" imports user code; components must not import src`,
  ]);
});

test("every command has the same base import and component public entry checks", () => {
  const root = goodApp({
    "cmds/cli.ts": 'import "#tinker/server";',
    "cmds/worker.ts": 'import "~/components/mail/private";',
    "tinker/components/mail/component.json": '{"requires":[]}',
    "tinker/components/mail/index.ts": "export const value = 1;",
  });

  expect(imports(root).lines).toEqual([
    'cmds/cli.ts:1 "#tinker/server" is a base-only name; app code cannot import it',
    `cmds/cli.ts:1 ${commandImport("#tinker/server")}`,
    'cmds/worker.ts:1 "~/components/mail/private" is private to component mail; use "~/components/mail"',
  ]);
});
