import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
const { parseSync } = createRequire(new URL("../../../tools/jev/package.json", import.meta.url))(
  "oxc-parser",
);

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageName = JSON.parse(await readFile(join(app, "package.json"), "utf8")).name;
const root = resolve(
  process.argv.slice(2).find((arg) => arg !== "--prove") ?? resolve(app, "src/scaffold"),
);
const seams = new Set(["@/lib/tinker", "@/lib/tinker.server", "@/routeTree.gen"]);
const sourceKinds = new Set([
  "ImportDeclaration",
  "ExportNamedDeclaration",
  "ExportAllDeclaration",
  "ImportExpression",
  "TSImportType",
]);
let files = 0;
async function check(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = resolve(folder, entry.name);
    if (entry.isDirectory()) await check(path);
    else if (/\.tsx?$/.test(entry.name)) {
      files += 1;
      const source = await readFile(path, "utf8");
      const { program, errors, comments } = parseSync(path, source);
      assert.equal(errors.length, 0, path);
      comments.forEach((comment) => checkReference(comment, path));
      visit(program, path, source);
    }
  }
}
function checkRelative(name, path, kind) {
  const target = relative(root, resolve(dirname(path), name));
  assert.ok(target !== ".." && !target.startsWith(`..${sep}`), `${path}: outside ${kind} ${name}`);
}
function checkImport(specifier, path) {
  assert.equal(typeof specifier.value, "string", `${path}: imports must be literal`);
  const name = specifier.value;
  assert.notEqual(name, packageName, `${path}: scaffold self package import ${name}`);
  assert.ok(!name.startsWith(`${packageName}/`), `${path}: scaffold self package import ${name}`);
  assert.ok(!name.startsWith("#"), `${path}: scaffold subpath import ${name}`);
  if (name.startsWith(".")) checkRelative(name, path, "relative import");
  else {
    assert.ok(
      seams.has(name) || (!name.startsWith("@/") && !name.startsWith("/")),
      `${path}: outside import ${name}`,
    );
  }
}
function checkReference(comment, path) {
  if (comment.type !== "Line" || !/^\/\s*<reference\b/.test(comment.value)) return;
  const reference = comment.value.match(/\bpath\s*=\s*(["'])(.*?)\1/);
  if (reference) checkRelative(reference.at(2), path, "reference path");
}
function checkDeclarations(node, path) {
  if (node.type === "TSModuleDeclaration" && node.id.type === "Literal") checkImport(node.id, path);
  if (node.type === "TSExternalModuleReference") checkImport(node.expression, path);
}
function isGlob(node) {
  return (
    node.type === "MemberExpression" &&
    node.object.type === "MetaProperty" &&
    node.object.meta.name === "import" &&
    node.object.property.name === "meta" &&
    ["glob", "globEager"].includes(node.property.name ?? node.property.value)
  );
}
function checkGlob(node, path, source) {
  if (node.type === "CallExpression" && isGlob(node.callee))
    assert.fail(`${path}: scaffold glob import ${source.slice(node.start, node.end)}`);
}
function children(node) {
  return Object.values(node)
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value) => value && typeof value === "object");
}
function visit(node, path, source) {
  if (sourceKinds.has(node.type) && node.source) checkImport(node.source, path);
  checkDeclarations(node, path);
  checkGlob(node, path, source);
  children(node).forEach((child) => visit(child, path, source));
}
await check(root);
console.log(`Seam check passed: ${files} scaffold files.`);

if (process.argv.includes("--prove")) {
  const planted = await mkdtemp(join(tmpdir(), "start-seam-red-"));
  const cases = [
    {
      name: "relative-export",
      source: 'export { fail } from "../errors.ts";',
      path: "../errors.ts",
    },
    {
      name: "type-import",
      source: 'import type { Database } from "../backend/database.ts";',
      path: "../backend/database.ts",
    },
    {
      name: "dynamic-import",
      source: 'import("../backend/database.ts");',
      path: "../backend/database.ts",
    },
    {
      name: "import-type",
      source: 'export type S = import("../frontend/state.ts").State;',
      path: "../frontend/state.ts",
    },
    ...["", "/frontend", "/backend", "/proof"].map((entry) => ({
      name: `self-package${entry.replace("/", "-")}`,
      source: `import * as user from "${packageName}${entry}";`,
      path: `${packageName}${entry}`,
    })),
    { name: "subpath", source: 'import * as user from "#frontend";', path: "#frontend" },
    {
      name: "declare-module",
      source: 'declare module "../frontend/state.ts" { type State = string; }',
      path: "../frontend/state.ts",
    },
    { name: "import-equals", source: 'import x = require("../errors.ts");', path: "../errors.ts" },
    { name: "glob", source: 'import.meta.glob("../backend/*.ts");', path: "../backend/*.ts" },
    {
      name: "triple-slash",
      source: '/// <reference path="../backend/auth.ts" />',
      path: "../backend/auth.ts",
    },
  ];
  try {
    await cp(root, join(planted, "scaffold"), { recursive: true });
    for (const probe of cases) {
      await writeFile(join(planted, "scaffold/seam-probe.ts"), probe.source + "\n");
      const red = spawnSync(
        process.execPath,
        [fileURLToPath(import.meta.url), join(planted, "scaffold")],
        { encoding: "utf8" },
      );
      await writeFile(
        join(tmpdir(), `start-seam-review-proof-${probe.name}.log`),
        red.stdout + red.stderr + `\nEXIT ${red.status}\n`,
      );
      assert.equal(red.status, 1, probe.name);
      assert.ok(
        red.stderr.includes(probe.path),
        `${probe.name}: diagnostic must name ${probe.path}`,
      );
      assert.match(red.stderr, /outside|scaffold self package|scaffold subpath|scaffold glob/);
      console.log(`PASS: ${probe.name} ${probe.path} EXIT 1.`);
    }
    await writeFile(
      join(planted, "scaffold/seam-probe.ts"),
      'export type S = import("@tinker/core").Scope;\n',
    );
    const legal = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), join(planted, "scaffold")],
      { encoding: "utf8" },
    );
    await writeFile(
      join(tmpdir(), "start-seam-review-proof-legal-import-type.log"),
      legal.stdout + legal.stderr + `\nEXIT ${legal.status}\n`,
    );
    assert.equal(legal.status, 0, legal.stdout + legal.stderr);
    console.log("PASS: legal import-type @tinker/core EXIT 0.");
  } finally {
    await rm(planted, { recursive: true, force: true });
  }
}
