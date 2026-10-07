import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseSync } from "oxc-parser";
import { lineAt } from "./paths.mjs";

/** @param {object} node - From oxc-parser; why: walk every child node. */
function children(node) {
  return Object.values(node)
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value) => value && typeof value === "object");
}

/**
 * Visit every node; a visitor that returns false skips that node's children.
 * @param {object} node - From parseSource; why: the tree to walk.
 * @param {(node: object) => boolean | void} visit - From a reader; why: what to collect.
 */
function walk(node, visit) {
  if (visit(node) === false) return;
  for (const child of children(node)) walk(child, visit);
}

/**
 * One parsed source file: its text, its tree, and the line of any node.
 * @param {string} path - From a check; why: the file to parse.
 */
export function parseSource(path) {
  const text = readFileSync(path, "utf8");
  const { program } = parseSync(path, text);
  return { text, program, line: (node) => lineAt(text, node.start) };
}

/**
 * Every module path the file names, with its line.
 * @param {ReturnType<typeof parseSource>} source - From parseSource; why: the file to read.
 */
export function specifiers(source) {
  const found = [];
  walk(source.program, (node) => {
    const name =
      node.type === "TSModuleDeclaration"
        ? node.id.value
        : node.type === "TSExternalModuleReference"
          ? node.expression.value
          : node.source?.value;
    if (typeof name === "string" && node.type !== "Literal")
      found.push({ name, line: source.line(node) });
  });
  return found;
}

/**
 * The identifiers one export statement names: `export const a`, `export function b`, `export { c }`.
 * @param {object} node - From exportsOf; why: one ExportNamedDeclaration.
 */
function exportedIds(node) {
  const declared = node.declaration?.declarations?.map((item) => item.id) ?? [];
  const named = node.specifiers.map((item) => item.exported);
  return [...declared, node.declaration?.id, ...named].filter(Boolean);
}

/** The paths a bundler tries for a relative module path, in order. */
const tried = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"];

/**
 * The file a relative `export * from` names, or null when it is a package or does not exist.
 * @param {string} from - From exportsOf; why: resolve the path from this file.
 * @param {string} name - From the export statement; why: the module path it names.
 */
function localModule(from, name) {
  if (!name.startsWith(".")) return null;
  const base = resolve(dirname(from), name);
  return (
    tried.map((end) => base + end).find((path) => existsSync(path) && statSync(path).isFile()) ??
    null
  );
}

/**
 * The names an `export *` adds: the target's own exports but `default`.
 * @param {string} from - From exportsOf; why: the file holding the statement.
 * @param {object} node - From exportsOf; why: one ExportAllDeclaration.
 * @param {Set<string>} seen - From exportsOf; why: a cycle of `export *` ends.
 */
function exportAll(from, node, seen) {
  const target = localModule(from, node.source.value);
  if (!target) return { names: new Map(), open: true };
  if (seen.has(target)) return { names: new Map(), open: false };
  const inner = exportsOf(target, seen);
  inner.names.delete("default");
  return inner;
}

/**
 * What one top-level statement exports, as [name, line] pairs, and whether it leaves the list
 * open (an `export *` from a package).
 * @param {string} path - From exportsOf; why: the file holding the statement.
 * @param {ReturnType<typeof parseSource>} source - From exportsOf; why: lines of its nodes.
 * @param {object} node - From exportsOf; why: one statement.
 * @param {Set<string>} seen - From exportsOf; why: a cycle of `export *` ends.
 */
function statementExports(path, source, node, seen) {
  const closed = (names) => ({ names, open: false });
  if (node.type === "ExportDefaultDeclaration") return closed([["default", source.line(node)]]);
  if (node.type === "ExportNamedDeclaration")
    return closed(exportedIds(node).map((id) => [id.name ?? id.value, source.line(id)]));
  if (node.type !== "ExportAllDeclaration") return closed([]);
  if (node.exported)
    return closed([[node.exported.name ?? node.exported.value, source.line(node)]]);
  const all = exportAll(path, node, seen);
  return { names: [...all.names], open: all.open };
}

/**
 * The names a file exports, each with its line. `export *` from a local file is followed;
 * `open` is true when one cannot be (a package), so a missing name then proves nothing.
 * @param {string} path - From a check; why: the file to read.
 * @param {Set<string>} [seen] - From exportAll; why: the files already read.
 */
export function exportsOf(path, seen = new Set()) {
  seen.add(path);
  const source = parseSource(path);
  const names = new Map();
  let open = false;
  for (const node of source.program.body) {
    const found = statementExports(path, source, node, seen);
    for (const [name, line] of found.names) if (!names.has(name)) names.set(name, line);
    open ||= found.open;
  }
  return { names, open };
}

/**
 * Whether a file exports a name, or may: an `export *` from a package cannot be read.
 * @param {string} path - From a check; why: the file to read.
 * @param {string} name - From a check; why: the export the base or TanStack reads.
 */
export function mayExport(path, name) {
  const { names, open } = exportsOf(path);
  return open || names.has(name);
}

/**
 * Each name a file imports from one module: the imported name, the local name, and the line.
 * @param {ReturnType<typeof parseSource>} source - From parseSource; why: the file to read.
 * @param {string} module - From a check; why: the module path to match.
 */
export function importsFrom(source, module) {
  return source.program.body
    .filter((node) => node.type === "ImportDeclaration" && node.source.value === module)
    .flatMap((node) =>
      node.specifiers.map((item) => ({
        imported: item.imported ? (item.imported.name ?? item.imported.value) : "default",
        local: item.local.name,
        line: source.line(node),
      })),
    );
}

/**
 * The line of each call to a function by name.
 * @param {ReturnType<typeof parseSource>} source - From parseSource; why: the file to read.
 * @param {string} name - From a check; why: the function whose calls count.
 */
export function callsOf(source, name) {
  const lines = [];
  walk(source.program, (node) => {
    if (node.type === "CallExpression" && node.callee.name === name) lines.push(source.line(node));
  });
  return lines;
}

/**
 * Each call to a function by name, with its line and its first argument when that is a string.
 * @param {ReturnType<typeof parseSource>} source - From parseSource; why: the file to read.
 * @param {string} name - From a check; why: the function whose calls count.
 */
export function stringCallsOf(source, name) {
  const found = [];
  walk(source.program, (node) => {
    if (node.type !== "CallExpression" || node.callee.name !== name) return;
    const [first] = node.arguments;
    const value = first?.type === "Literal" && typeof first.value === "string" ? first.value : null;
    found.push({ line: source.line(node), value });
  });
  return found;
}

/**
 * Nodes that use a name outside import lines: a JSX tag or a plain identifier.
 * @param {ReturnType<typeof parseSource>} source - From parseSource; why: the file to read.
 * @param {string} name - From a check; why: the name to look for.
 */
export function usesOf(source, name) {
  const lines = [];
  walk(source.program, (node) => {
    if (node.type === "ImportDeclaration") return false;
    if (/^(JSX)?Identifier$/.test(node.type) && node.name === name) lines.push(source.line(node));
    return true;
  });
  return lines;
}

/**
 * Object properties by key name, such as `component:` in a route's options.
 * @param {ReturnType<typeof parseSource>} source - From parseSource; why: the file to read.
 * @param {string} key - From a check; why: the property key to find.
 */
export function propertiesOf(source, key) {
  const found = [];
  walk(source.program, (node) => {
    if (node.type === "Property" && node.key.name === key) found.push(node);
  });
  return found;
}

/**
 * Names the file imports from other modules.
 * @param {ReturnType<typeof parseSource>} source - From parseSource; why: the file to read.
 */
export function importedNames(source) {
  return new Set(
    source.program.body
      .filter((node) => node.type === "ImportDeclaration")
      .flatMap((node) => node.specifiers.map((item) => item.local.name)),
  );
}

/**
 * The interfaces a file adds to a module by augmentation: `declare module "m" { interface I {} }`.
 * @param {ReturnType<typeof parseSource>} source - From a check; why: the file to read.
 */
export function augmentations(source) {
  const found = [];
  walk(source.program, (node) => {
    if (node.type !== "TSModuleDeclaration" || typeof node.id?.value !== "string") return;
    for (const item of node.body?.body ?? [])
      if (item.type === "TSInterfaceDeclaration")
        found.push({ module: node.id.value, name: item.id.name });
  });
  return found;
}
