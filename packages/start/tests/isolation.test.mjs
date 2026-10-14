import { expect, test } from "vite-plus/test";

import { imports } from "../lib/checks/imports.mjs";
import { goodApp } from "./fixture.mjs";

test("src and items cannot import command files", () => {
  const root = goodApp({
    "src/user.ts": 'import entry from "../cmds/server";',
    "tinker/components/demo/component.json": '{"requires":[]}',
    "tinker/components/demo/index.ts": 'import entry from "../../../cmds/server";',
  });

  const checked = imports(root);

  expect(checked.lines).toEqual([
    'src/user.ts:1 "../cmds/server" imports a command; src must not import cmds',
    'tinker/components/demo/index.ts:1 "../../../cmds/server" imports a command; components must not import cmds',
  ]);
});
