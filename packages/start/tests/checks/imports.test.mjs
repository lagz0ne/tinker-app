import { join, relative } from "node:path";
import { expect, test } from "vite-plus/test";
import { imports } from "../../lib/checks/imports.mjs";
import { baseDir } from "../../lib/paths.mjs";
import { goodApp, write } from "../fixture.mjs";

test("passes when src/ reaches the base only through its entries", () => {
  const root = goodApp({
    "src/backend/greet.ts":
      'import { readResult } from "@tinker/start/server";\nimport { x } from "./x";\n',
    "src/frontend/tab.ts": 'import { syncClient } from "@tinker/start/client";\n',
  });
  expect(imports(root)).toEqual({
    status: "ok",
    lines: ["3 files in src/ import the base only through its entries"],
  });
});

test("names each import that goes around the base's entries, at its line", () => {
  const root = goodApp();
  const linked = relative(join(root, "src/backend"), join(baseDir, "src/errors"));
  const peek = [
    'import { extensions } from "#tinker/app.server";',
    'import { raise } from "@tinker/start/src/errors";',
    'import { body } from "../../node_modules/@tinker/start/src/backend/body.server";',
    'import handler from "@tanstack/react-start/server-entry";',
    `export { raise as again } from "${linked}";`,
  ];
  write(root, { "src/backend/peek.ts": `${peek.join("\n")}\n` });
  expect(imports(root).lines).toEqual([
    'src/backend/peek.ts:1 "#tinker/app.server" is a base-only name; app code cannot import it',
    'src/backend/peek.ts:2 "@tinker/start/src/errors" is not a base entry; use @tinker/start, @tinker/start/server, @tinker/start/client, or @tinker/start/vite',
    'src/backend/peek.ts:3 "../../node_modules/@tinker/start/src/backend/body.server" reaches into the base by path; use a base entry',
    'src/backend/peek.ts:4 "@tanstack/react-start/server-entry" skips the base\'s scope; use createServerEntry from @tinker/start/server',
    `src/backend/peek.ts:5 "${linked}" reaches into the base by path; use a base entry`,
  ]);
});

test("names module declarations and import-equals that bypass the base entries", () => {
  const root = goodApp({
    "src/peek.ts":
      'declare module "#tinker/app" { interface X {} }\nimport app = require("@tinker/start/src/index");\n',
  });
  expect(imports(root).lines).toEqual([
    'src/peek.ts:1 "#tinker/app" is a base-only name; app code cannot import it',
    'src/peek.ts:2 "@tinker/start/src/index" is not a base entry; use @tinker/start, @tinker/start/server, @tinker/start/client, or @tinker/start/vite',
  ]);
});

test("names an absolute path into the linked base", () => {
  const path = join(baseDir, "src/errors");
  const root = goodApp({ "src/peek.ts": `export { raise } from "${path}";\n` });
  expect(imports(root).lines).toEqual([
    `src/peek.ts:1 "${path}" reaches into the base by path; use a base entry`,
  ]);
});

test("names TypeScript import endings in app source, tests, and config files", () => {
  const ts = "." + "ts";
  const tsx = "." + "tsx";
  const mts = "." + "mts";
  const root = goodApp({
    "src/endings.mts": `import { x } from "./x${ts}";\nexport * from "./view${tsx}";\nimport("./lazy${mts}");\ntype T = import("./types${ts}").T;\n`,
    "tests/endings.test.ts": `import "../src/x${ts}";\n`,
    "vite.config.mts": `import "./config${mts}";\n`,
    "src/assets.ts":
      'import "./plain.mjs"; import "./style.css"; import "./data.json"; import "./asset.ts?url";\n',
    "dist/generated.ts": `import "./ignored${ts}";\n`,
    ".tinker/generated.ts": `import "./ignored${ts}";\n`,
  });
  expect(imports(root)).toEqual({
    status: "fail",
    lines: [
      ["src/endings.mts:1", `./x${ts}`],
      ["src/endings.mts:2", `./view${tsx}`],
      ["src/endings.mts:3", `./lazy${mts}`],
      ["src/endings.mts:4", `./types${ts}`],
      ["tests/endings.test.ts:1", `../src/x${ts}`],
      ["vite.config.mts:1", `./config${mts}`],
    ].map(
      ([at, name]) =>
        `${at} "${name}" ends in a TypeScript file extension; remove .ts, .tsx, or .mts from the import`,
    ),
  });
});
