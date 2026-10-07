import { mkdirSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { expect, test } from "vite-plus/test";
import { checkTypes, typeErrors } from "../lib/typecheck.mjs";
import { prepare } from "../lib/prepare.mjs";
import { fixture, write } from "./fixture.mjs";

test("tsc's errors read as file:line:col, and detail lines drop", () => {
  const output = [
    "src/routes/nav.tsx(3,37): error TS2820: Type '\"/tinkr\"' is not assignable to type '\"/tinker\"'.",
    "  Did you mean '\"/tinker\"'?",
    "error TS5083: Cannot read file '.tinker/tsconfig.json'.",
  ].join("\n");
  expect(typeErrors(output)).toEqual([
    "src/routes/nav.tsx:3:37 TS2820 Type '\"/tinkr\"' is not assignable to type '\"/tinker\"'.",
    "TS5083 Cannot read file '.tinker/tsconfig.json'.",
  ]);
});

test("an app without typescript cannot pass the build's type check", () => {
  expect(checkTypes(fixture({ "package.json": "{}" }))).toEqual([
    "typescript is not installed in the app; vp build checks types with it, so add it to devDependencies",
  ]);
});

test("the app's own tsc runs, and a type error comes back with its spot", () => {
  const root = fixture({
    "package.json": "{}",
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, noEmit: true },
      include: ["src"],
    }),
    "src/a.ts": 'export const n: number = "x";\n',
  });
  const typescript = dirname(createRequire(import.meta.url).resolve("typescript/package.json"));
  mkdirSync(join(root, "node_modules"));
  symlinkSync(typescript, join(root, "node_modules/typescript"), "dir");
  expect(checkTypes(root)).toEqual([
    "tsc found 1 type error(s); the build stops here:",
    "src/a.ts:1:14 TS2322 Type 'string' is not assignable to type 'number'.",
  ]);
});

test("the generated config rejects TypeScript import endings and accepts paths without them", () => {
  const ts = "." + "ts";
  const root = fixture({
    "package.json": "{}",
    "tsconfig.json": JSON.stringify({
      extends: "./.tinker/tsconfig.json",
      compilerOptions: { types: [] },
    }),
    "src/value.ts": "export const value = 1;\n",
    "src/index.ts": `import { value } from "./value${ts}";\nexport { value };\n`,
  });
  const typescript = dirname(createRequire(import.meta.url).resolve("typescript/package.json"));
  mkdirSync(join(root, "node_modules"));
  symlinkSync(typescript, join(root, "node_modules/typescript"), "dir");
  prepare(root, []);
  expect(checkTypes(root)).toEqual([
    "tsc found 1 type error(s); the build stops here:",
    `src/index.ts:1:23 TS5097 An import path can only end with a '${ts}' extension when 'allowImportingTsExtensions' is enabled.`,
  ]);
  write(root, { "src/index.ts": 'import { value } from "./value";\nexport { value };\n' });
  expect(checkTypes(root)).toEqual([]);
});
