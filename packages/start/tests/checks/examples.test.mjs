import { expect, test } from "vite-plus/test";

import { examples } from "../../lib/checks/examples.mjs";
import { goodApp } from "../fixture.mjs";

test("an installed example names each missing part switch", () => {
  const root = goodApp({
    "src/examples/demo.tinker.json": JSON.stringify({ name: "demo", parts: ["auth", "sync"] }),
  });

  const checked = examples(root);

  expect(checked.lines).toEqual([
    "demo: needs the auth part; set tinker({ auth: true }) in vite.config.ts",
    "demo: needs the sync part; set tinker({ sync: true }) in vite.config.ts",
  ]);
});

test("with its remaining package part on, the app owns the example's wiring", () => {
  const root = goodApp({
    ".tinker/base.json": '{"parts":["auth","sync"]}',
    "src/examples/demo.tinker.json": JSON.stringify({ name: "demo", parts: ["auth"] }),
  });

  const checked = examples(root);

  expect(checked.status).toBe("ok");
});
