import { expect, test } from "vite-plus/test";

import { imports } from "../lib/checks/imports.mjs";
import { goodApp } from "./fixture.mjs";

test("src and items cannot import command files", () => {
  const root = goodApp({
    "src/user.ts": 'import entry from "../cmds/server";',
    "src/items/demo/item.json": '{"requires":[]}',
    "src/items/demo/index.ts": 'import entry from "../../../cmds/server";',
  });

  const checked = imports(root);

  expect(checked.lines).toEqual([
    'src/items/demo/index.ts:1 "../../../cmds/server" imports a command; src must not import cmds',
    'src/user.ts:1 "../cmds/server" imports a command; src must not import cmds',
  ]);
});
