import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import {
  exportsOf,
  importsFrom,
  mayExport,
  parseSource,
  specifiers,
  stringCallsOf,
  usesOf,
} from "../lib/source.mjs";
import { fixture } from "./fixture.mjs";

/**
 * One parsed file in a fresh folder with its neighbours.
 * @param {string} text - From a test; why: the file to read.
 * @param {Record<string, string>} [files] - From a test; why: the files it names.
 */
function parsed(text, files = {}) {
  const root = fixture({ "a.ts": text, ...files });
  return { root, path: join(root, "a.ts"), source: parseSource(join(root, "a.ts")) };
}

test("every module path a file names is found with its line, and nothing else", () => {
  const { source } = parsed(
    [
      'import a from "one";',
      'export { b } from "two";',
      'export * from "three";',
      'const c = await import("four");',
      'import d = require("five");',
      'declare module "six" {}',
      "declare namespace Seven {}",
      'const e = "eight";',
    ].join("\n"),
  );

  expect(specifiers(source)).toEqual([
    { name: "one", line: 1 },
    { name: "two", line: 2 },
    { name: "three", line: 3 },
    { name: "four", line: 4 },
    { name: "five", line: 5 },
    { name: "six", line: 6 },
  ]);
});

test("each kind of export statement names its exports, with the first line kept", () => {
  const { path } = parsed(
    [
      "export const a = 1, { b, c: d } = {};",
      "export function f() {}",
      'export { g, g as "h i" };',
      "export default 1;",
      'export * as ns from "pkg";',
      'export * as "str ns" from "pkg";',
      "const g = 2;",
      "export const a2 = a;",
    ].join("\n"),
  );

  const { names, open } = exportsOf(path);

  expect(Object.fromEntries(names)).toEqual({
    a: 1,
    b: 1,
    d: 1,
    f: 2,
    g: 3,
    "h i": 3,
    default: 4,
    ns: 5,
    "str ns": 6,
    a2: 8,
  });
  expect(open).toBe(false);
});

test("export * follows each path a bundler tries, without their defaults", () => {
  const ends = [
    "x.js",
    "t.ts",
    "tx.tsx",
    "j.js",
    "jx.jsx",
    "it/index.ts",
    "itx/index.tsx",
    "ij/index.js",
  ];
  const names = ["exact", "ts", "tsx", "js", "jsx", "indexTs", "indexTsx", "indexJs"];
  const files = Object.fromEntries(
    ends.map((end, at) => [end, `export const ${names[at]} = 1;\nexport default 1;\n`]),
  );
  const { path } = parsed(
    [
      'export * from "./x.js";',
      'export * from "./t";',
      'export * from "./tx";',
      'export * from "./j";',
      'export * from "./jx";',
      'export * from "./it";',
      'export * from "./itx";',
      'export * from "./ij";',
      "export const local = 1;",
    ].join("\n"),
    files,
  );

  const found = exportsOf(path);

  expect([...found.names.keys()]).toEqual([...names, "local"]);
  expect(found.open).toBe(false);
});

test("a name the file exports itself wins over the same name from export *", () => {
  const { path } = parsed('export const same = 1;\nexport * from "./b";\n', {
    "b.ts": "\n\nexport const same = 2;\nexport const other = 3;\n",
  });

  expect(Object.fromEntries(exportsOf(path).names)).toEqual({ same: 1, other: 4 });
});

test("a cycle of export * ends, with each name once", () => {
  const { path } = parsed('export * from "./b";\nexport const a = 1;\n', {
    "b.ts": 'export * from "./a";\nexport const b = 1;\n',
  });

  const found = exportsOf(path);

  expect([...found.names.keys()]).toEqual(["b", "a"]);
  expect(found.open).toBe(false);
});

test("export * from a package leaves the list open, even with a same-named local file", () => {
  const { path } = parsed('export const a = 1;\nexport * from "react";\nexport const b = 1;\n', {
    "react.ts": "export const fromFile = 1;\n",
  });

  const found = exportsOf(path);

  expect([...found.names.keys()]).toEqual(["a", "b"]);
  expect(found.open).toBe(true);
  expect(mayExport(path, "anything")).toBe(true);
});

test("a missing local export * target leaves the list open", () => {
  const { path } = parsed('export * from "./gone";\n');

  expect(exportsOf(path).open).toBe(true);
});

test("mayExport is false for a name a closed file does not export", () => {
  const { path } = parsed("export const a = 1;\n");

  expect(mayExport(path, "a")).toBe(true);
  expect(mayExport(path, "b")).toBe(false);
});

test("imports from one module: default, named, string, and namespace", () => {
  const { source } = parsed(
    [
      'import d, { a as b, "x y" as z } from "m";',
      'import * as ns from "m";',
      'import other from "n";',
    ].join("\n"),
  );

  expect(importsFrom(source, "m")).toEqual([
    { imported: "default", local: "d", line: 1 },
    { imported: "a", local: "b", line: 1 },
    { imported: "x y", local: "z", line: 1 },
    { imported: "default", local: "ns", line: 2 },
  ]);
});

test("string calls keep a string first argument only", () => {
  const { source } = parsed('f("x");\nf(1);\nf();\nf(`t`);\ng("y");\n');

  expect(stringCallsOf(source, "f")).toEqual([
    { line: 1, value: "x" },
    { line: 2, value: null },
    { line: 3, value: null },
    { line: 4, value: null },
  ]);
});

test("uses of a name count identifiers and JSX tags, never import lines or other names", () => {
  const root = fixture({
    "a.tsx": [
      'import { Outlet } from "r";',
      "const Other = 1;",
      "const x = <Outlet />;",
      "Outlet();",
      "const o = { a: Other };",
    ].join("\n"),
  });

  const lines = usesOf(parseSource(join(root, "a.tsx")), "Outlet");

  expect(lines).toEqual([3, 4]);
});

test("a private field of the same name is not a use", () => {
  const { source } = parsed(
    "const k = { f: () => 1 };\nexport const make = () => class { #Outlet = 1; };\n",
  );

  expect(usesOf(source, "Outlet")).toEqual([]);
});
