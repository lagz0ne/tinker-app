import { expect, test } from "vite-plus/test";

import { named } from "../../lib/checks/named.mjs";
import { goodApp } from "../fixture.mjs";

test("passes with only the app's named server entry", () => {
  expect(named(goodApp()).status).toBe("ok");
});

test("names each entry export the base reads", () => {
  const root = goodApp({
    "cmds/router.ts": "export const options = {};",
    "src/start.ts": "export const start = 1;",
    "cmds/server.ts": "export const fetch = 1;",
  });

  const checked = named(root);

  expect(checked.lines).toEqual([
    "cmds/router.ts:1 does not export router; the base imports it from this file",
    "cmds/router.ts:1 does not export extensions; the base imports it from this file",
    "src/start.ts:1 does not export startInstance; the base imports it from this file",
    "cmds/server.ts:1 does not export default; the base imports it from this file",
  ]);
});

test("star exports do not supply the server default", () => {
  const root = goodApp({
    "cmds/server.ts": 'export * from "../src/own";',
    "src/own.ts": "export default 1; export const settings = () => [];",
  });

  const checked = named(root);

  expect(checked.lines).toEqual([
    "cmds/server.ts:1 does not export default; the base imports it from this file",
  ]);
});

test("the entry location comes from the app's Vite config", () => {
  const root = goodApp({
    "vite.config.ts":
      'import {tinker} from "@tinker/start/vite"; export default {plugins:[tinker({serverEntry:"cmds/shop.ts"})]};',
    "cmds/shop.ts": "export default 1;",
  });

  const checked = named(root);

  expect(checked.status).toBe("ok");
});

test("a missing entry option shows the Vite config line to add", () => {
  const root = goodApp({
    "vite.config.ts":
      'import {tinker} from "@tinker/start/vite"; export default {plugins:[tinker()]};',
  });

  const checked = named(root);

  expect(checked.lines).toEqual([
    'vite.config.ts: name the server entry with tinker({ serverEntry: "cmds/server.ts" })',
  ]);
});

test("auth needs only the default command export; app wiring is checked at run time", () => {
  const root = goodApp({
    ".tinker/base.json": '{"parts":["auth"]}',
    "cmds/server.ts": "export default 1;",
  });

  const checked = named(root);

  expect(checked.status).toBe("ok");
});

test("copied sync reads no client command exports or package Register", () => {
  const root = goodApp({
    ".tinker/base.json": '{"parts":["auth","sync"]}',
    "cmds/server.ts": "export default 1;",
    "cmds/router.ts": "export const router = {}; export const extensions = [];",
  });
  expect(named(root)).toEqual({
    status: "ok",
    lines: [
      "each named or seam file exports what the base reads (cmds/router.ts, cmds/server.ts); no Start file is ignored",
    ],
  });
});

test("doctor reads client command exports from an object pattern", () => {
  const root = goodApp({
    ".tinker/base.json": '{"parts":["auth"]}',
    "cmds/router.ts":
      "const values = {router:() => ({}),extensions:[]}; export const {router,extensions} = values;",
  });

  const checked = named(root);

  expect(checked.status).toBe("ok");
});
