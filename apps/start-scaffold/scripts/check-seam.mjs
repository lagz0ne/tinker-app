import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { parseSync } = createRequire(new URL("../../../tools/jev/package.json", import.meta.url))(
  "oxc-parser",
);

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(
  process.argv.slice(2).find((arg) => arg !== "--prove") ?? resolve(app, "src/scaffold"),
);
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

if (process.argv.includes("--prove")) {
  const planted = await mkdtemp(join(tmpdir(), "start-seam-red-"));
  try {
    await cp(root, join(planted, "scaffold"), { recursive: true });
    await writeFile(
      join(planted, "scaffold/relative-import.ts"),
      'export { fail } from "../errors.ts";\n',
    );
    const red = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), join(planted, "scaffold")],
      { encoding: "utf8" },
    );
    assert.equal(red.status, 1);
    assert.match(red.stderr, /outside relative import \.\.\/errors\.ts/);
    await writeFile(
      join(tmpdir(), "start-seam-planted-red.log"),
      red.stdout + red.stderr + `\nEXIT ${red.status}\n`,
    );
    console.log("PASS: planted outside import EXIT 1; real scaffold EXIT 0.");
  } finally {
    await rm(planted, { recursive: true, force: true });
  }
}
