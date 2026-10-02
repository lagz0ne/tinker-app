import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const { parseSync } = createRequire(new URL("../../../tools/jev/package.json", import.meta.url))(
  "oxc-parser",
);

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(process.argv[2] ?? resolve(app, "src/scaffold"));
const seams = new Set(["@/lib/tinker", "@/lib/tinker.server", "@/routeTree.gen"]);
let files = 0;
async function check(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = resolve(folder, entry.name);
    if (entry.isDirectory()) await check(path);
    else if (/\.tsx?$/.test(entry.name)) {
      files += 1;
      const { program, errors } = parseSync(path, await readFile(path, "utf8"));
      assert.equal(errors.length, 0, path);
      visit(program, path);
    }
  }
}
function checkImport(specifier, path) {
  assert.equal(typeof specifier.value, "string", `${path}: imports must be literal`);
  const name = specifier.value;
  if (name.startsWith(".")) {
    const target = relative(root, resolve(dirname(path), name));
    assert.ok(
      target !== ".." && !target.startsWith(`..${sep}`),
      `${path}: outside relative import ${name}`,
    );
  } else {
    assert.ok(
      seams.has(name) || (!name.startsWith("@/") && !name.startsWith("/")),
      `${path}: outside import ${name}`,
    );
  }
}
function children(node) {
  return Object.values(node)
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value) => value && typeof value === "object");
}
function visit(node, path) {
  if (!node || typeof node !== "object") return;
  if (
    [
      "ImportDeclaration",
      "ExportNamedDeclaration",
      "ExportAllDeclaration",
      "ImportExpression",
    ].includes(node.type) &&
    node.source
  )
    checkImport(node.source, path);
  if (node.type === "TSImportType") checkImport(node.argument, path);
  children(node).forEach((child) => visit(child, path));
}
await check(root);
console.log(`Seam check passed: ${files} scaffold files.`);
