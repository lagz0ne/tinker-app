import { expect, test } from "vite-plus/test";

import { glue } from "../lib/checks/glue.mjs";
import { imports, commandImport } from "../lib/checks/imports.mjs";
import { named } from "../lib/checks/named.mjs";
import { readComponentModules } from "../lib/component-modules.mjs";
import { render } from "../lib/prepare.mjs";
import { goodApp, write } from "./fixture.mjs";

test("components keep src and commands out, through aliases and relative paths", () => {
  const root = goodApp({
    "tinker/components/mail/component.json": '{"requires":[]}',
    "tinker/components/mail/index.ts":
      'import "@/user";\nexport * from "../../../cmds/server";\nimport "../../base/server";',
    "src/user.ts": 'import "../cmds/server";\nimport "~/base/server";',
  });

  expect(imports(root).lines).toEqual([
    'src/user.ts:1 "../cmds/server" imports a command; src must not import cmds',
    'src/user.ts:2 "~/base/server" imports copied base code; src must not import tinker/base',
    'tinker/components/mail/index.ts:1 "@/user" imports user code; components must not import src',
    'tinker/components/mail/index.ts:2 "../../../cmds/server" imports a command; components must not import cmds',
    'tinker/components/mail/index.ts:3 "../../base/server" imports copied base code; components must not import tinker/base',
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
    'tinker/components/db/component.json: unknown key "order"; only requires are allowed',
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

test.each([
  ["{", "invalid JSON"],
  ["null", "expected an object with only requires"],
  ["[]", "expected an object with only requires"],
  ['{"requires":null}', "requires must be an array of component names"],
  ['{"requires":"mail"}', "requires must be an array of component names"],
  ['{"requires":["Bad"]}', "requires must be an array of component names"],
  ['{"requires":[1]}', "requires must be an array of component names"],
  ['{"requires":["mail"]}', "cannot require itself (tinker/components/mail)"],
  [
    '{"requires":["missing"]}',
    "requires missing component tinker/components/missing; shadcn add it",
  ],
])("doctor rejects manifest %s", (manifest, message) => {
  const root = goodApp({
    "tinker/components/mail/component.json": manifest,
    "tinker/components/mail/index.ts": "export const value = 1;",
  });

  const checked = named(root);

  expect(checked.status).toBe("fail");
  expect(checked.lines).toEqual([`tinker/components/mail/component.json: ${message}`]);
});

test("doctor names every manifest in a requires cycle", () => {
  const root = goodApp({
    "tinker/components/mail/component.json": '{"requires":["store"]}',
    "tinker/components/store/component.json": '{"requires":["mail"]}',
  });

  const checked = named(root);

  expect(checked.status).toBe("fail");
  expect(checked.lines).toEqual([
    "component requires cycle: tinker/components/mail/component.json -> tinker/components/store/component.json -> tinker/components/mail/component.json",
  ]);
});

test.each(["Mail", "mail_box", "2fa", "01-mail"])("doctor rejects component folder %s", (name) => {
  const root = goodApp({ [`tinker/components/${name}/component.json`]: '{"requires":[]}' });

  const checked = named(root);

  expect(checked.status).toBe("fail");
  expect(checked.lines).toEqual([
    name === "01-mail"
      ? "tinker/components/01-mail: rename to tinker/components/mail and declare requires in component.json"
      : `tinker/components/${name}: component names must match [a-z][a-z0-9-]*`,
  ]);
});

test("doctor refuses nested commands", () => {
  const root = goodApp({ "cmds/lib/helper.ts": 'import "node:fs"; import "zod";' });

  const checked = imports(root);

  expect(checked.status).toBe("fail");
  expect(checked.lines).toEqual([
    "cmds/lib/helper.ts: commands must be files directly under cmds; move it to cmds/helper.ts",
  ]);
});

test("an unused framework package is not a command import", () => {
  const root = goodApp({ "cmds/probe.ts": 'import "@tanstack/react-router";' });

  const checked = imports(root);

  expect(checked.status).toBe("fail");
  expect(checked.lines).toEqual([`cmds/probe.ts:1 ${commandImport("@tanstack/react-router")}`]);
});

test("component manifests reject the retired env field", () => {
  const root = goodApp({
    "tinker/components/caps/component.json": JSON.stringify({ requires: [], env: {} }),
  });
  expect(readComponentModules(root).problems).toEqual([
    'tinker/components/caps/component.json: unknown key "env"; only requires are allowed',
  ]);
});

test.each(["~/components/../../outside", "~/base/../components/../../outside", "@/../cmds/server"])(
  "command aliases cannot escape their allowed roots: %s",
  (name) => {
    const checked = imports(goodApp({ "cmds/probe.ts": `import "${name}";` }));
    expect(checked.lines).toEqual([`cmds/probe.ts:1 ${commandImport(name)}`]);
  },
);

test.each(["auth", "database", "http", "health", "mail", "demo"])(
  "base cannot import optional %s",
  (name) => {
    const checked = imports(goodApp({ "tinker/base/probe.ts": `import "~/components/${name}";` }));
    expect(checked.lines).toContain(
      `tinker/base/probe.ts:1 "~/components/${name}" imports an optional component; the command must pass it into base`,
    );
  },
);
