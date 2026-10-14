import { readdirSync } from "node:fs";
import { join, dirname, resolve, sep, isAbsolute, posix } from "node:path";

import { readComponentModules } from "../component-modules.mjs";
import { installedBase } from "../paths.mjs";
import { parseSource, specifiers } from "../source.mjs";
import { verdict } from "./result.mjs";

export const say = {
  extension: (at, name) =>
    `${at} "${name}" ends in a TypeScript file extension; remove .ts, .tsx, or .mts from the import`,
  seam: (at, name) => `${at} "${name}" is a base-only name; app code cannot import it`,
  entry: (at, name) =>
    `${at} "${name}" is not a base entry; use @tinker/start, @tinker/start/server, @tinker/start/client, or @tinker/start/vite`,
  path: (at, name) => `${at} "${name}" reaches into the base by path; use a base entry`,
  serverEntry: (at, name) =>
    `${at} "${name}" skips the command's scope; put server setup in the configured command`,
  passed: (count) => `${count} source files import the base only through its entries`,
};

const skipped = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".tinker",
  ".tanstack",
  ".stryker-tmp",
]);

/** App source, tests, and config files; dependencies and generated output are not app code. */
function appSources(root, dir = "") {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    if (skipped.has(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return appSources(root, path);
    return /\.[cm]?[jt]sx?$/.test(path) ? [path] : [];
  });
}

/** A finding at the module path's own line, including a dynamic or type-only import. */
function extensionImports(sources) {
  return sources.flatMap(({ file, imports }) =>
    imports
      .filter(({ name }) => /\.(ts|tsx|mts)$/.test(name))
      .map(({ name, line }) => say.extension(`${file}:${line}`, name)),
  );
}

const entries = new Set([
  "@tinker/start",
  "@tinker/start/server",
  "@tinker/start/client",
  "@tinker/start/vite",
]);

/** Commands remain plain mains; Start stays allowed until its base registry split. */
export function commandImport(name) {
  if (
    name.startsWith("~/") ||
    name.startsWith("@/") ||
    name === "@tinker/core" ||
    name === "@tanstack/react-start/server-entry" ||
    ["@tinker/start", "@tinker/start/server", "@tinker/start/client"].includes(name)
  ) {
    return null;
  }

  return `"${name}" is not a command import; use ~/, @/, @tinker/core, or the framework entry; @tinker/start is allowed until Start is decomposed into base registry components (next card)`;
}

/**
 * @param {string} name - From an import; why: a relative path may point into the base.
 * @param {string} file - From the src walk; why: resolve the path from it.
 * @param {string | null} base - From installedBase; why: a linked base folder.
 */
function reachesBase(name, file, base) {
  const target = name.startsWith(".") || isAbsolute(name) ? resolve(dirname(file), name) : "";
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

/** Test files may reach private files, as with the package barrel rule. */
function isTest(file) {
  return /(?:^|\/)tests\//.test(file) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file);
}

/** Public entries have fixed names; tests may import any file. */
function isPrivate(path, file) {
  return Boolean(path) && !["index", "index.server"].includes(path) && !isTest(file);
}

/** Missing helper manifests need a file to add, rather than an edit to an absent file. */
function checkComponentRequires(at, name, item, owner, folders) {
  if (!owner) return null;
  const from = folders.find((folder) => folder.name === owner);
  if (from?.requires.includes(item)) return null;

  const manifest = `tinker/components/${owner}/component.json`;
  return from?.files.has("component.json")
    ? `${at} "${name}" needs "${item}" in ${manifest} requires`
    : `${at} "${name}" needs "${item}"; add ${manifest} with { "requires": ["${item}"] }`;
}

/** Import paths, including re-exports and dynamic imports, obey one item's public entry. */
function componentImport(name, file, line, folders, root) {
  const resolved = sourcePath(name, file, root);
  const target = /^tinker\/components\/([^/]+)(?:\/(.*))?$/.exec(resolved ?? "");
  if (!target) return [];
  const [, item, path] = target;

  const owner = /^tinker\/components\/([^/]+)\//.exec(file)?.[1];
  if (owner === item) return [];
  const at = `${file}:${line}`;
  const problems = [];

  if (isPrivate(path, file)) {
    const serverEntry = /\.server\.[cm]?[jt]sx?$/.test(file)
      ? ` or "~/components/${item}/index.server"`
      : "";
    problems.push(
      `${at} "${name}" is private to component ${item}; use "~/components/${item}"${serverEntry}`,
    );
  }

  const missing = checkComponentRequires(at, name, item, owner, folders);
  if (missing) problems.push(missing);
  return problems;
}

/** Graph errors belong to named files; check 6 reports import boundaries without loading items. */
function componentImports(root, sources) {
  const { declared: folders } = readComponentModules(root);
  return sources.flatMap(({ file, imports }) =>
    imports.flatMap(({ name, line }) => componentImport(name, file, line, folders, root)),
  );
}

/** Map app aliases and relative imports to the same project path. */
function sourcePath(name, file, root) {
  if (isAbsolute(name)) return posix.relative(root, name);
  if (name.startsWith("@/")) return posix.normalize(`src/${name.slice(2)}`);
  if (name.startsWith("~/")) return posix.normalize(`tinker/${name.slice(2)}`);
  return name.startsWith(".") ? posix.join(posix.dirname(file), name) : null;
}

/** Only src and components have one-way access to commands and copied base code. */
function sourceOwner(file) {
  if (file.startsWith("src/")) return "src";
  if (file.startsWith("tinker/components/")) return "components";
  return null;
}

/** The source folder determines which direction an import may cross. */
export function isolatedImport(root, file, name, line) {
  const target = sourcePath(name, file, root);
  const owner = sourceOwner(file);
  if (!owner || !target) return [];

  if (target === "tinker/base" || target.startsWith("tinker/base/")) {
    return [
      `${file}:${line} "${name}" imports copied base code; ${owner} must not import tinker/base`,
    ];
  }
  if (target.startsWith("cmds/")) {
    return [`${file}:${line} "${name}" imports a command; ${owner} must not import cmds`];
  }
  if (owner === "components" && target.startsWith("src/")) {
    return [`${file}:${line} "${name}" imports user code; components must not import src`];
  }
  return [];
}

function isolation(root, sources) {
  return sources.flatMap(({ file, imports }) =>
    imports.flatMap(({ name, line }) => isolatedImport(root, file, name, line)),
  );
}

/**
 * Check 6: app code reaches the base only through its entries, and never by a base-only
 * `#tinker/*` name or a path into the package. App imports omit TypeScript file endings.
 * No fix: doctor never edits app code.
 */
export function imports(root) {
  const base = installedBase(root);
  const sources = appSources(root).map((file) => ({
    file,
    imports: specifiers(parseSource(join(root, file))),
  }));
  const files = sources.filter(
    ({ file }) => /^(src|cmds|tinker)\//.test(file) && /\.[cm]?[jt]sx?$/.test(file),
  );

  const bad = files.flatMap(({ file, imports }) => {
    const path = join(root, file);
    return imports
      .map(({ name, line }) => ({
        name,
        at: `${file}:${line}`,
        message:
          /^cmds\/[^/]+\.[cm]?[jt]sx?$/.test(file) && name === "@tanstack/react-start/server-entry"
            ? null
            : badImport(name, path, base),
      }))
      .filter(({ message }) => message)
      .map(({ name, at, message }) => message(at, name));
  });
  return verdict(
    [
      ...bad,
      ...sources
        .filter(({ file }) => /^cmds\/[^/]+\//.test(file))
        .map(
          ({ file }) =>
            `${file}: commands must be files directly under cmds; move it to cmds/${file.split("/").at(-1)}`,
        ),
      ...sources.flatMap(({ file, imports }) =>
        /^cmds\/[^/]+\.[cm]?[jt]sx?$/.test(file)
          ? imports.flatMap(({ name, line }) => {
              const message = commandImport(name);
              return message ? [`${file}:${line} ${message}`] : [];
            })
          : [],
      ),
      ...extensionImports(sources),
      ...componentImports(root, sources),
      ...isolation(root, sources),
    ],
    say.passed(files.length),
  );
}
