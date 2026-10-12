import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { recordedParts } from "../parts.mjs";
import { listFiles, readJson } from "../paths.mjs";
import { importsFrom, mayExport, parseSource } from "../source.mjs";
import { verdict } from "./result.mjs";

export const say = {
  part: (item, part) =>
    `${item}: needs the ${part} part; set tinker({ ${part}: true }) in vite.config.ts`,
  seam: (item, file, name, line) => `${item}: ${file}:1 needs ${name}; add ${line}`,
  setup: (item, file, name, line) =>
    `${item}: ${file}:1 needs ${name} in extensions; keep your extensions and add it, or use ${line}`,
  passed: "installed examples have their parts and seam exports",
};

/**
 * The file a module path names, so `@/x` and `../x` from the same seam compare equal (ADR 0112).
 * @param {string} root - From examples; why: `@/` is the app's `src/`.
 * @param {string} path - From hasSetup; why: a relative path starts at the seam file.
 * @param {string} name - From the seam or the receipt; why: the module path to place.
 */
function placeOf(root, path, name) {
  if (name.startsWith("@/")) return join(root, "src", name.slice(2));
  if (name.startsWith(".")) return resolve(dirname(path), name);
  return name;
}

/**
 * An example's startup extension may be re-exported, or joined to the user's own list.
 * @param {string} root - From examples; why: places `@/` module paths.
 * @param {string} path - From the seam check; why: the user's existing seam stays theirs.
 * @param {object} needed - From the copied item metadata; why: the extension and its module.
 */
function hasSetup(root, path, needed) {
  const source = parseSource(path);
  const names = source.program.body.flatMap((node) => node.source?.value ?? []);
  const named = (module) => {
    const place = placeOf(root, path, module);
    return names.filter((name) => placeOf(root, path, name) === place);
  };

  const fromDemo = named(needed.from);
  const reexport = source.program.body.some((node) => {
    if (!fromDemo.includes(node.source?.value)) return false;
    if (node.type === "ExportAllDeclaration") return !node.exported;
    return (
      node.type === "ExportNamedDeclaration" &&
      node.specifiers.some(
        (item) => item.local.name === "extensions" && item.exported.name === "extensions",
      )
    );
  });
  if (reexport) return true;

  const locals = [
    ...fromDemo.flatMap((module) =>
      importsFrom(source, module).filter((item) => item.imported === "extensions"),
    ),
    ...named(needed.include.from).flatMap((module) =>
      importsFrom(source, module).filter((item) => item.imported === needed.include.name),
    ),
  ].map((item) => item.local);
  return source.program.body.some((node) => {
    const declaration = node.type === "ExportNamedDeclaration" ? node.declaration : node;
    return (
      declaration?.type === "VariableDeclaration" &&
      declaration.declarations.some(
        (item) =>
          item.id.name === "extensions" &&
          item.init?.type === "ArrayExpression" &&
          item.init.elements.some((element) =>
            locals.includes(element?.name ?? element?.argument?.name),
          ),
      )
    );
  });
}

/**
 * The copied receipt carries the item's requirements; no registry or network is needed.
 * @param {string} root - From doctor; why: read the app's receipts, part record, and seams.
 */
export function examples(root) {
  const on = recordedParts(root);
  const problems = listFiles(join(root, "src/examples"))
    .filter((file) => file.endsWith(".tinker.json"))
    .flatMap((file) => {
      const item = readJson(join(root, "src/examples", file));
      const missingParts = item.parts
        .filter((part) => !on.includes(part))
        .map((part) => say.part(item.name, part));
      const missingSeams = Object.entries(item.seams).flatMap(([file, names]) =>
        Object.entries(names).flatMap(([name, needed]) => {
          const path = join(root, file);
          if (!existsSync(path) || !mayExport(path, name)) {
            return [say.seam(item.name, file, name, needed.line)];
          }
          if (needed.include && !hasSetup(root, path, needed)) {
            return [say.setup(item.name, file, needed.include.name, needed.line)];
          }
          return [];
        }),
      );
      return [...missingParts, ...missingSeams];
    });
  return verdict(problems, say.passed);
}
