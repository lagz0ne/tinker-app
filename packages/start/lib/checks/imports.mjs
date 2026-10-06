import { join, dirname, resolve, sep } from "node:path";
import { installedBase, listFiles } from "../paths.mjs";
import { parseSource, specifiers } from "../source.mjs";
import { verdict } from "./result.mjs";

export const say = {
  seam: (at, name) => `${at} "${name}" is a base-only name; app code cannot import it`,
  entry: (at, name) =>
    `${at} "${name}" is not a base entry; use @tinker/start, @tinker/start/server, @tinker/start/client, or @tinker/start/vite`,
  path: (at, name) => `${at} "${name}" reaches into the base by path; use a base entry`,
  serverEntry: (at, name) =>
    `${at} "${name}" skips the base's scope; use createServerEntry from @tinker/start/server`,
  passed: (count) => `${count} files in src/ import the base only through its entries`,
};

const entries = new Set([
  "@tinker/start",
  "@tinker/start/server",
  "@tinker/start/client",
  "@tinker/start/vite",
]);

/**
 * @param {string} name - From an import; why: a relative path may point into the base.
 * @param {string} file - From the src walk; why: resolve the path from it.
 * @param {string | null} base - From installedBase; why: a linked base folder.
 */
function reachesBase(name, file, base) {
  const target = name.startsWith(".") ? resolve(dirname(file), name) : "";
  if (target.includes(`${sep}node_modules${sep}@tinker${sep}start${sep}`)) return true;
  return Boolean(base && target.startsWith(base + sep));
}

/**
 * Which message a module path earns, or null when the import is fine.
 * @param {string} name - From an import; why: judge that one path.
 * @param {string} file - From the src walk; why: resolve a relative path from it.
 * @param {string | null} base - From installedBase; why: a relative path must not reach it.
 */
function badImport(name, file, base) {
  if (name.startsWith("#tinker/")) return say.seam;
  if (name === "@tanstack/react-start/server-entry") return say.serverEntry;
  if (name.startsWith("@tinker/start") && !entries.has(name)) return say.entry;
  return reachesBase(name, file, base) ? say.path : null;
}

/**
 * Check 6: app code reaches the base only through its entries, and never by a base-only
 * `#tinker/*` name or a path into the package. No fix: doctor never edits src/.
 */
export function imports(root) {
  const base = installedBase(root);
  const files = listFiles(join(root, "src")).filter((file) => /\.[jt]sx?$/.test(file));
  const bad = files.flatMap((file) => {
    const path = join(root, "src", file);
    return specifiers(parseSource(path))
      .map(({ name, line }) => ({
        name,
        at: `src/${file}:${line}`,
        message: badImport(name, path, base),
      }))
      .filter(({ message }) => message)
      .map(({ name, at, message }) => message(at, name));
  });
  return verdict(bad, say.passed(files.length));
}
