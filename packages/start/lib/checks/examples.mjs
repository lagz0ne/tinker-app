import { existsSync } from "node:fs";
import { join } from "node:path";
import { listFiles, readJson } from "../paths.mjs";
import { recordedParts } from "../parts.mjs";
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
 * An example's startup extension may be re-exported, or joined to the user's own list.
 * @param {string} path - From the seam check; why: the user's existing seam stays theirs.
 * @param {object} needed - From the copied item metadata; why: the extension and its module.
 */
function hasSetup(path, needed) {
  const source = parseSource(path);
  const reexport = source.program.body.some((node) => {
    if (node.source?.value !== needed.from) return false;
    if (node.type === "ExportAllDeclaration") return !node.exported;
    return (
      node.type === "ExportNamedDeclaration" &&
      node.specifiers.some(
        (item) => item.local.name === "extensions" && item.exported.name === "extensions",
      )
    );
  });
  if (reexport) return true;
  const names = [
    ...importsFrom(source, needed.from).filter((item) => item.imported === "extensions"),
    ...importsFrom(source, needed.include.from).filter(
      (item) => item.imported === needed.include.name,
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
            names.includes(element?.name ?? element?.argument?.name),
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
          if (!existsSync(path) || !mayExport(path, name))
            return [say.seam(item.name, file, name, needed.line)];
          if (needed.include && !hasSetup(path, needed))
            return [say.setup(item.name, file, needed.include.name, needed.line)];
          return [];
        }),
      );
      return [...missingParts, ...missingSeams];
    });
  return verdict(problems, say.passed);
}
