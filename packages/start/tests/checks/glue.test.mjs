import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { glue } from "../../lib/checks/glue.mjs";
import { runCheck } from "../../lib/doctor.mjs";
import { fixture, goodApp } from "../fixture.mjs";

const glued = 'import { tinker } from "@tinker/start/vite";\n';

test("passes on one tinker() call, the extends line, and the postinstall script", () => {
  expect(glue(goodApp())).toEqual({
    status: "ok",
    lines: [
      "vite.config.ts calls tinker() once; tsconfig.json extends .tinker; postinstall runs tinker prepare",
    ],
  });
});

test("reads vite.config.ts as code: a comment or single quotes do not count", () => {
  const root = goodApp({
    "vite.config.ts":
      "import { tinker } from '@tinker/start/vite';\n// tinker() below\nexport default { plugins: [tinker()] };\n",
  });
  expect(glue(root).status).toBe("ok");
});

test("fails with no vite.config.ts", () => {
  const root = fixture({
    "tsconfig.json": JSON.stringify({ extends: "./.tinker/tsconfig.json" }),
    "package.json": JSON.stringify({ scripts: { postinstall: "tinker prepare" } }),
  });
  expect(glue(root).lines).toEqual(["vite.config.ts is missing; add one with plugins: [tinker()]"]);
});

test("names a missing import, and an import with no call", () => {
  const root = goodApp({ "vite.config.ts": "export default { plugins: [] };\n" });
  expect(glue(root).lines).toEqual([
    'vite.config.ts:1 does not import tinker from "@tinker/start/vite"',
  ]);
  const uncalled = goodApp({
    "vite.config.ts":
      'import { defineConfig } from "vite-plus";\nimport { tinker } from "@tinker/start/vite";\nexport default {};\n',
  });
  expect(glue(uncalled).lines).toEqual([
    "vite.config.ts:2 does not call tinker(); add plugins: [tinker()]",
  ]);
});

test("counts tinker() under the name it is imported as, in any Vite config file name", () => {
  const renamed =
    'import { tinker as base } from "@tinker/start/vite";\nexport default { plugins: [base()] };\n';
  expect(glue(goodApp({ "vite.config.ts": renamed })).status).toBe("ok");
  const mts = goodApp({ "vite.config.mts": renamed });
  rmSync(join(mts, "vite.config.ts"));
  expect(glue(mts).lines).toEqual([
    "vite.config.mts calls tinker() once; tsconfig.json extends .tinker; postinstall runs tinker prepare",
  ]);
  const twice = goodApp({
    "vite.config.mjs":
      'import { tinker as base } from "@tinker/start/vite";\nexport default { plugins: [base(), base()] };\n',
  });
  rmSync(join(twice, "vite.config.ts"));
  expect(glue(twice).lines).toEqual([
    "vite.config.mjs:2 calls tinker() 2 times; call it once: plugins: [tinker()]",
  ]);
});

test("names a second tinker(), a tanstackStart(), and a Tailwind plugin, each at its line", () => {
  const root = goodApp({
    "vite.config.ts": `${glued}import tailwindcss from "@tailwindcss/vite";\nexport default {\n  plugins: [tinker(), tinker(), tanstackStart(), tailwindcss()],\n};\n`,
  });
  expect(glue(root).lines).toEqual([
    "vite.config.ts:4 calls tinker() 2 times; call it once: plugins: [tinker()]",
    "vite.config.ts:4 adds tanstackStart(); tinker() adds it already",
    "vite.config.ts:2 imports @tailwindcss/vite; tinker() adds Tailwind already",
  ]);
});

test("names a tsconfig that does not extend .tinker, or overrides paths or strict", () => {
  const root = goodApp({
    "tsconfig.json":
      '{\n  "compilerOptions": {\n    "strict": false,\n    "paths": { "x": ["y"] }\n  }\n}\n',
  });
  expect(glue(root).lines).toEqual([
    'tsconfig.json:1 does not extend "./.tinker/tsconfig.json"',
    "tsconfig.json:4 sets compilerOptions.paths; it replaces the base's #tinker/* and @/* paths, so remove it",
    "tsconfig.json:3 turns strict off; the base's files need strict",
  ]);
});

test("names a package.json with no postinstall that runs tinker prepare", () => {
  const root = goodApp({ "package.json": JSON.stringify({ scripts: { build: "vp build" } }) });
  expect(glue(root).lines).toEqual([
    'package.json:1 has no "postinstall": "tinker prepare"; a fresh clone has no .tinker/',
  ]);
});

test("reads tsconfig.json as tsc does: a comment and a trailing comma are fine", () => {
  const root = goodApp({
    "tsconfig.json":
      '{\n  // the app\'s own options\n  "extends": "./.tinker/tsconfig.json",\n  "compilerOptions": { "jsx": "react-jsx", },\n}\n',
  });
  expect(glue(root).status).toBe("ok");
});

test("--fix adds only the extends key, and keeps comments, trailing commas, and options", () => {
  const tsconfig =
    '{\n  // the app\'s own options\n  "compilerOptions": { "jsx": "react-jsx", },\n}\n';
  const root = goodApp({ "tsconfig.json": tsconfig });
  expect(runCheck(root, glue, true).status).toBe("fixed");
  expect(readFileSync(join(root, "tsconfig.json"), "utf8")).toBe(
    '{\n  "extends": "./.tinker/tsconfig.json",\n  // the app\'s own options\n  "compilerOptions": { "jsx": "react-jsx", },\n}\n',
  );
});

test("a tsconfig.json that does not parse is named at its line, and --fix never writes it", () => {
  const broken = '{\n  "compilerOptions": {\n    "jsx": "react-jsx"\n    "strict": true\n  }\n}\n';
  const root = goodApp({ "tsconfig.json": broken });
  const result = glue(root);
  expect(result.lines).toEqual([
    "tsconfig.json:4 does not parse (CommaExpected); doctor never edits a file that does not parse",
  ]);
  expect(result.fix).toBeUndefined();
  expect(runCheck(root, glue, true).status).toBe("fail");
  expect(readFileSync(join(root, "tsconfig.json"), "utf8")).toBe(broken);
});

test("package.json is strict JSON, as npm reads it: a comment is named, and --fix never writes it", () => {
  const broken = '{\n  // no comments in package.json\n  "name": "app"\n}\n';
  const root = goodApp({ "package.json": broken });
  expect(glue(root).lines).toEqual([
    "package.json:2 does not parse (InvalidCommentToken); doctor never edits a file that does not parse",
  ]);
  expect(runCheck(root, glue, true).status).toBe("fail");
  expect(readFileSync(join(root, "package.json"), "utf8")).toBe(broken);
});

test("an extends array that holds .tinker passes; --fix adds .tinker first to one that lacks it", () => {
  const listed = goodApp({
    "strict.json": '{ "compilerOptions": { "noUncheckedIndexedAccess": true } }\n',
    "tsconfig.json": '{\n  "extends": ["./.tinker/tsconfig.json", "./strict.json"]\n}\n',
  });
  expect(glue(listed).status).toBe("ok");
  const lacking = goodApp({
    "strict.json": '{ "compilerOptions": { "noUncheckedIndexedAccess": true } }\n',
    "tsconfig.json": '{\n  "extends": ["./strict.json"]\n}\n',
  });
  expect(runCheck(lacking, glue, true).status).toBe("fixed");
  expect(readFileSync(join(lacking, "tsconfig.json"), "utf8")).toBe(
    '{\n  "extends": ["./.tinker/tsconfig.json", "./strict.json"]\n}\n',
  );
});

test("--fix keeps an extends that names another file: .tinker goes first, the file stays", () => {
  const root = goodApp({
    "strict.json": "{}\n",
    "tsconfig.json": '{\n  "extends": "./strict.json"\n}\n',
  });
  expect(runCheck(root, glue, true).status).toBe("fixed");
  expect(JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")).extends).toEqual([
    "./.tinker/tsconfig.json",
    "./strict.json",
  ]);
});

test("a tsconfig.json with a byte order mark parses, and --fix keeps the mark", () => {
  const marked = goodApp({
    "tsconfig.json": '\uFEFF{\n  "extends": "./.tinker/tsconfig.json"\n}\n',
  });
  expect(glue(marked).status).toBe("ok");
  const bare = goodApp({ "tsconfig.json": '\uFEFF{\n  "compilerOptions": {}\n}\n' });
  expect(runCheck(bare, glue, true).status).toBe("fixed");
  expect(readFileSync(join(bare, "tsconfig.json"), "utf8")).toBe(
    '\uFEFF{\n  "extends": "./.tinker/tsconfig.json",\n  "compilerOptions": {}\n}\n',
  );
});

test("--fix indents a new key as the file does: tabs and CRLF stay", () => {
  const root = goodApp({
    "tsconfig.json": '{\r\n\t// my options\r\n\t"compilerOptions": {},\r\n}\r\n',
    "package.json": '{\n\t"name": "app"\n}\n',
  });
  expect(runCheck(root, glue, true).status).toBe("fixed");
  expect(readFileSync(join(root, "tsconfig.json"), "utf8")).toBe(
    '{\r\n\t"extends": "./.tinker/tsconfig.json",\r\n\t// my options\r\n\t"compilerOptions": {},\r\n}\r\n',
  );
  expect(readFileSync(join(root, "package.json"), "utf8")).toBe(
    '{\n\t"scripts": {\n\t\t"postinstall": "tinker prepare"\n\t},\n\t"name": "app"\n}\n',
  );
});

test("--fix writes the extends line and the postinstall script, and keeps the rest", () => {
  const root = goodApp({
    "tsconfig.json": JSON.stringify({ compilerOptions: { jsx: "react-jsx" } }),
    "package.json": JSON.stringify({ scripts: { build: "vp build" } }),
  });
  expect(runCheck(root, glue, true)).toEqual({
    status: "fixed",
    lines: ["wrote the extends line in tsconfig.json and the postinstall script in package.json"],
  });
  expect(JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8"))).toEqual({
    compilerOptions: { jsx: "react-jsx" },
    extends: "./.tinker/tsconfig.json",
  });
  expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts).toEqual({
    build: "vp build",
    postinstall: "tinker prepare",
  });
});

test("--fix never edits vite.config.ts", () => {
  const root = goodApp({ "vite.config.ts": "export default {};\n" });
  expect(glue(root).fix).toBeUndefined();
});
