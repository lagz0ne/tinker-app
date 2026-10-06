import { join, relative } from "node:path";
import { expect, test } from "vite-plus/test";
import { imports } from "../../lib/checks/imports.mjs";
import { baseDir } from "../../lib/paths.mjs";
import { goodApp, write } from "../fixture.mjs";

test("passes when src/ reaches the base only through its entries", () => {
  const root = goodApp({
    "src/backend/greet.ts":
      'import { readResult } from "@tinker/start/server";\nimport { x } from "./x.ts";\n',
  });
  expect(imports(root)).toEqual({
    status: "ok",
    lines: ["2 files in src/ import the base only through its entries"],
  });
});

test("names each import that goes around the base's entries, at its line", () => {
  const root = goodApp();
  const linked = relative(join(root, "src/backend"), join(baseDir, "src/errors.ts"));
  const peek = [
    'import { extensions } from "#tinker/app.server";',
    'import { raise } from "@tinker/start/src/errors.ts";',
    'import { body } from "../../node_modules/@tinker/start/src/backend/body.server.ts";',
    'import handler from "@tanstack/react-start/server-entry";',
    `export { raise as again } from "${linked}";`,
  ];
  write(root, { "src/backend/peek.ts": `${peek.join("\n")}\n` });
  expect(imports(root).lines).toEqual([
    'src/backend/peek.ts:1 "#tinker/app.server" is a base-only name; app code cannot import it',
    'src/backend/peek.ts:2 "@tinker/start/src/errors.ts" is not a base entry; use @tinker/start, @tinker/start/server, @tinker/start/client, or @tinker/start/vite',
    'src/backend/peek.ts:3 "../../node_modules/@tinker/start/src/backend/body.server.ts" reaches into the base by path; use a base entry',
    'src/backend/peek.ts:4 "@tanstack/react-start/server-entry" skips the base\'s scope; use createServerEntry from @tinker/start/server',
    `src/backend/peek.ts:5 "${linked}" reaches into the base by path; use a base entry`,
  ]);
});
