import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { entryOf, readLock, writeLock } from "./lock.mjs";
import { basePackage, listFiles } from "./paths.mjs";
import { readRegistryJson } from "./registry.mjs";
import { parseSource } from "./source.mjs";

/** A refusal: the lines to print and exit 1, with no write behind it. */
export class Refusal {
  /** @param {string[]} lines - From a command; why: what the user reads. */
  constructor(lines) {
    this.lines = lines;
  }
}

/** @param {string} root - From a command; why: the app holding the temp folders. */
function workOf(root) {
  return join(root, ".tinker/update");
}

/** @param {string} name - From a command; why: the component folder under `tinker/`. */
function folderOf(root, name) {
  return join(root, "tinker/components", name);
}

/** @param {string} name - From a command; why: the app path prefix the folder owns. */
function areaOf(name) {
  return `tinker/components/${name}/`;
}

/** @param {string} name - From a command; why: the manifest that marks an item as a component. */
function manifestOf(name) {
  return `~/tinker/components/${name}/component.json`;
}

/** Component names are folder names: lower case letters, digits and dashes. */
const nameShape = /^[a-z0-9][a-z0-9-]*$/;

/** The only folder a component may write outside its own: the migrations it owns. */
const outsideRoot = "drizzle/";

/**
 * An app-relative path for a registry target, or null when the target would leave the app.
 * @param {string} target - From an item's `files[]`; why: where the file lands.
 */
function appPath(target) {
  if (!target.startsWith("~/")) return null;
  const parts = target.slice(2).split("/");
  return parts.includes("..") || parts.includes("") ? null : parts.join("/");
}

/**
 * `name@spec` as its parts; a scoped name keeps its own `@`, a URL spec keeps its own.
 * @param {string} text - From an item's dependency list; why: split name from spec.
 */
function splitDep(text) {
  const at = text.indexOf("@", 1);
  return at === -1
    ? { name: text, spec: "latest" }
    : { name: text.slice(0, at), spec: text.slice(at + 1) };
}

/**
 * The registry, read once per command.
 * @param {string} base - From the command; why: where the index and items live.
 */
async function catalogOf(base) {
  const index = await readRegistryJson(base, "registry.json");
  const items = index.items ?? [];
  return {
    base,
    names: new Set(items.map((item) => item.name)),
    metas: new Map(items.map((item) => [item.name, item.meta ?? {}])),
    items: new Map(),
  };
}

/**
 * One item JSON, read once.
 * @param {{ base: string, items: Map<string, object> }} catalog - From catalogOf; why: the cache.
 * @param {string} name - From a command; why: the item to read.
 */
async function itemOf(catalog, name) {
  if (!catalog.items.has(name)) {
    catalog.items.set(name, await readRegistryJson(catalog.base, `${name}.json`));
  }
  return catalog.items.get(name);
}

/**
 * The item for a component, or the refusal for an unknown item or a non-component one.
 * @param {{ names: Set<string>, items: Map<string, object> }} catalog - From catalogOf; why: the index.
 * @param {string} name - From a command; why: the item asked for.
 */
async function componentItem(catalog, name) {
  if (!nameShape.test(name) || !catalog.names.has(name)) {
    throw new Refusal([`unknown component: ${name}`]);
  }

  const item = await itemOf(catalog, name);
  const files = (item.files ?? []).map((file) => file.target);
  if (!files.includes(manifestOf(name))) {
    throw new Refusal([
      `${name} is not a component; tinker add copies tinker/components/${name} only`,
    ]);
  }
  return item;
}

/**
 * Every file of an item, keyed by app path, or the refusal for a target that escapes the app.
 * @param {object} item - From componentItem; why: the files to copy.
 * @param {string} name - From a command; why: the item's name, for the message.
 */
function filesOf(item, name) {
  const files = new Map();
  for (const file of item.files ?? []) {
    const path = appPath(file.target);
    if (path === null || !ownedPath(path, name)) {
      throw new Refusal([`bad target ${file.target} in ${name}`]);
    }
    files.set(path, file.content);
  }
  return files;
}

/**
 * Whether a target lands in the component's own folder, or under the one outside folder allowed.
 * @param {string} path - From filesOf; why: the app-relative target.
 * @param {string} name - From filesOf; why: the component that would write it.
 */
function ownedPath(path, name) {
  return path.startsWith(areaOf(name)) || path.startsWith(outsideRoot);
}

/**
 * The components one item names in its own registry manifest.
 * @param {object} item - From componentItem; why: its manifest file.
 * @param {string} name - From a command; why: the item's name.
 */
function requiresOf(item, name) {
  const manifest = (item.files ?? []).find((file) => file.target === manifestOf(name));
  return JSON.parse(manifest?.content ?? "{}").requires ?? [];
}

/**
 * `name` and every component it requires, each once, requires first.
 * @param {{ items: Map<string, object> }} catalog - From catalogOf; why: the items to walk.
 * @param {string} name - From a command; why: the component asked for.
 */
async function closureOf(catalog, name) {
  const order = [];
  const seen = new Set();

  const visit = async (member) => {
    if (seen.has(member)) return;
    seen.add(member);
    for (const required of requiresOf(await componentItem(catalog, member), member)) {
      await visit(required);
    }
    order.push(member);
  };

  await visit(name);
  return order;
}

/**
 * Refuse a closure that holds a starter-only item.
 * @param {{ metas: Map<string, object> }} catalog - From catalogOf; why: the index `meta`.
 * @param {string[]} closure - From closureOf; why: every member that would land.
 */
function refuseStarterOnly(catalog, closure) {
  for (const member of closure) {
    const meta = catalog.metas.get(member) ?? {};
    if (meta.starterOnly !== true) continue;

    const why = meta.starterOnlyWhy ?? "it needs the starter's toolchain";
    throw new Refusal([`${member} is starter-only: ${why}`]);
  }
}

/**
 * Sort text the same way on every machine.
 * @param {string} a - From a sort; why: keep the order stable.
 * @param {string} b - From a sort; why: keep the order stable.
 */
function byText(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** @param {Buffer | string} bytes - From a compare; why: the sha256 hex the lock records. */
function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The differences between the app and its lock entry: changed, missing, then added in the folder.
 * @param {string} root - From a command; why: the app to read.
 * @param {string} name - From a command; why: the component to diff.
 * @param {{ files: Record<string, string> }} entry - From readLock; why: what it was copied from.
 */
function lockDiffOf(root, name, entry) {
  const files = entry.files ?? {};
  const lines = [];
  for (const [path, hash] of Object.entries(files)) {
    const safe = appPath(`~/${path}`);
    if (safe === null) {
      lines.push(`bad lock path: ${path}`);
      continue;
    }

    const file = join(root, safe);
    if (!existsSync(file)) lines.push(`missing: ${path}`);
    else if (digest(readFileSync(file)) !== hash) lines.push(`changed: ${path}`);
  }

  const locked = new Set(Object.keys(files));
  const folder = folderOf(root, name);
  for (const path of listFiles(folder, folder).sort(byText)) {
    if (!locked.has(`${areaOf(name)}${path}`)) lines.push(`added: ${areaOf(name)}${path}`);
  }
  return lines;
}

/**
 * The hashes the registry item's bytes would give, without writing them.
 * @param {Map<string, string>} files - From filesOf; why: the registry copy.
 */
function registryHashes(files) {
  const hashes = {};
  for (const [path, content] of files) hashes[path] = digest(content);
  return hashes;
}

/**
 * Whether two path -> hash maps name the same files with the same bytes.
 * @param {Record<string, string>} left - From a lock entry; why: the recorded files.
 * @param {Record<string, string>} right - From registryHashes; why: the registry files.
 */
function sameFiles(left, right) {
  const paths = Object.keys(left);
  if (paths.length !== Object.keys(right).length) return false;
  return paths.every((path) => right[path] === left[path]);
}

/**
 * A `changed:` line whose local bytes already equal the new copy: replacing it loses nothing.
 * @param {string} root - From updateComponent; why: the app to read.
 * @param {string} line - From a lock diff; why: one `changed: <path>` line.
 * @param {Map<string, string>} files - From filesOf; why: the registry copy.
 */
function alreadyNew(root, line, files) {
  if (!line.startsWith("changed: ")) return false;
  const path = line.slice("changed: ".length);
  return files.get(path) === readFileSync(join(root, path), "utf8");
}

/** @param {string} appFile - From a diff; why: rewrite one `changed: <path>` line for check. */
function editedLine(appFile) {
  const [kind, ...rest] = appFile.split(": ");
  return `edited: ${rest.join(": ")} (${kind})`;
}

/**
 * The differences between an app folder and the registry copy: changed, missing, then added.
 * @param {string} root - From a command; why: the app to read.
 * @param {string} name - From a command; why: the component to diff.
 * @param {Map<string, string>} files - From filesOf; why: the registry copy.
 */
function diffOf(root, name, files) {
  const lines = [];
  for (const [path, content] of files) {
    const file = join(root, path);
    if (!existsSync(file)) lines.push(`missing: ${path}`);
    else if (readFileSync(file, "utf8") !== content) lines.push(`changed: ${path}`);
  }

  const local = folderOf(root, name);
  for (const path of listFiles(local, local).sort(byText)) {
    if (!files.has(`${areaOf(name)}${path}`)) lines.push(`added: ${areaOf(name)}${path}`);
  }
  return lines;
}

/**
 * Remove the temp folder when nothing is left in it.
 * @param {string} dir - From writeFolder or recover; why: `<root>/.tinker/update`.
 */
function clearWork(dir) {
  if (existsSync(dir) && readdirSync(dir).length === 0) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Write every file into a fresh folder, cleaning it up when one write fails.
 * @param {string} dir - From writeFolder; why: the staging folder.
 * @param {Map<string, string>} files - From a member; why: folder-relative path to content.
 * @param {object} ops - From writeFolder; why: the fs ops a test can fail on purpose.
 */
async function fillFolder(dir, files, ops) {
  await ops.rm(dir, { recursive: true, force: true });
  try {
    for (const [path, content] of files) {
      const file = join(dir, path);
      await ops.mkdir(dirname(file), { recursive: true });
      await ops.writeFile(file, content);
    }
  } catch (error) {
    await ops.rm(dir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Replace a component folder whole: stage it, move the old one aside, swap, delete the old one.
 * A failure at any step leaves the old folder whole and removes the staging folder.
 * @param {string} root - From a command; why: the app to write in.
 * @param {string} name - From a command; why: the component to replace.
 * @param {Map<string, string>} files - From a member; why: folder-relative path to content.
 * @param {object} ops - From a command; why: the fs ops a test can fail on purpose.
 */
async function swapFolder(root, name, files, ops) {
  const target = folderOf(root, name);
  const work = join(root, ".tinker/update");
  const fresh = join(work, `${name}.new`);
  const old = join(work, `${name}.old`);
  let moved = false;

  await ops.mkdir(work, { recursive: true });
  await ops.mkdir(dirname(target), { recursive: true });
  try {
    await fillFolder(fresh, files, ops);
    if (existsSync(target)) {
      await ops.rename(target, old);
      moved = true;
    }
    await ops.rename(fresh, target);
  } catch (error) {
    await undoSwap(root, name, ops, moved);
    throw error;
  }
  return moved;
}

/**
 * Delete the moved-aside folder. Best effort: the folder is already the registry copy, and the
 * next add or update recovery drops a leftover `.old`.
 * @param {string} root - From a command; why: the app holding `.tinker/update`.
 * @param {string} name - From a command; why: the component whose copy was replaced.
 * @param {object} ops - From a command; why: the fs ops a test can fail on purpose.
 */
async function dropOld(root, name, ops) {
  const old = join(root, ".tinker/update", `${name}.old`);
  if (!existsSync(old)) return;

  await ops.rm(old, { recursive: true, force: true }).catch(() => null);
  clearWork(join(root, ".tinker/update"));
}

/**
 * Undo a swap this run made: rename the new folder aside, put the old one back, then delete the
 * new one. Nothing is deleted in place, so a kill here always leaves one whole copy.
 * @param {string} root - From a command; why: the app holding `.tinker/update`.
 * @param {string} name - From a command; why: the component to put back.
 * @param {object} ops - From a command; why: the fs ops a test can fail on purpose.
 * @param {boolean} moved - From swapFolder; why: only an update THIS run moved has a folder to put back.
 */
async function undoSwap(root, name, ops, moved) {
  const target = folderOf(root, name);
  const work = workOf(root);
  const old = join(work, `${name}.old`);
  const undo = join(work, `${name}.undo`);

  if (moved) await restoreSwap(target, ops, old, undo);
  await ops.rm(join(work, `${name}.new`), { recursive: true, force: true }).catch(() => null);
  clearWork(work);
}

/**
 * Put the old folder back without deleting anything in place: the new folder is renamed aside
 * first, so a kill at any point leaves one whole copy (`.undo` + `.old`, or the old folder).
 * @param {string} target - From undoSwap; why: the component folder.
 * @param {object} ops - From undoSwap; why: the fs ops a test can fail on purpose.
 * @param {string} old - From undoSwap; why: the moved-aside previous copy.
 * @param {string} undo - From undoSwap; why: where the new copy waits while the old one returns.
 */
async function restoreSwap(target, ops, old, undo) {
  if (!existsSync(target)) {
    if (existsSync(old)) await ops.rename(old, target);
    return;
  }

  await ops.rename(target, undo);
  await ops.rename(old, target);
  await ops.rm(undo, { recursive: true, force: true }).catch(() => null);
}

/**
 * Write one file through `<file>.tinker-new`, so the swap over the target is one rename.
 * @param {string} file - From a command; why: the app file to write.
 * @param {string} content - From the registry; why: the bytes.
 * @param {object} ops - From a command; why: the fs ops a test can fail on purpose.
 */
async function writeAtomic(file, content, ops) {
  await ops.mkdir(dirname(file), { recursive: true });
  await ops.writeFile(`${file}.tinker-new`, content);
  await ops.rename(`${file}.tinker-new`, file);
}

/**
 * Finish or undo an update a killed process left behind, for this component only.
 * @param {string} root - From a command; why: the app holding `.tinker/update`.
 * @param {string} name - From a command; why: the component to recover.
 * @param {string[]} paths - From a command; why: the registry item's files, for an outside file.
 */
async function recover(root, name, ops, paths) {
  const work = workOf(root);
  const target = folderOf(root, name);
  const old = join(work, `${name}.old`);
  const fresh = join(work, `${name}.new`);
  const lines = await undoStep(root, name, ops);

  if (existsSync(old) && !existsSync(target)) {
    await ops.mkdir(dirname(target), { recursive: true });
    await ops.rename(old, target);
    lines.push(restoredMessage(name));
  } else if (existsSync(old)) {
    await recordEntry(root, name, ops, paths);
    await dropOld(root, name, ops);
    lines.push(finishedMessage(name));
  }

  if (existsSync(fresh)) await ops.rm(fresh, { recursive: true, force: true });
  clearWork(work);
  return lines;
}

/**
 * An undo that died: `.undo` holds the new copy and `.old` the previous one. Put the previous
 * copy back when the folder is gone, then drop `.undo`; the registry copy is written again.
 * @param {string} root - From recover; why: the app holding `.tinker/update`.
 * @param {string} name - From recover; why: the component to clean up.
 * @param {object} ops - From recover; why: the fs ops a test can fail on purpose.
 */
async function undoStep(root, name, ops) {
  const work = workOf(root);
  const target = folderOf(root, name);
  const old = join(work, `${name}.old`);
  const undo = join(work, `${name}.undo`);
  if (!existsSync(undo)) return [];

  const lines = [];
  if (!existsSync(target) && existsSync(old)) {
    await ops.mkdir(dirname(target), { recursive: true });
    await ops.rename(old, target);
    lines.push(restoredMessage(name));
  }
  await ops.rm(undo, { recursive: true, force: true });
  return lines;
}

/**
 * Record one component in the lock from the bytes on disk, merging into the entries it holds.
 * @param {string} root - From a command; why: the app to write in.
 * @param {string} name - From a command; why: the component that just landed.
 * @param {object} ops - From a command; why: the fs ops a test can fail on purpose.
 * @param {string[]} paths - From a command; why: the registry item's files, for an outside file.
 */
async function recordEntry(root, name, ops, paths) {
  const lock = await readLock(root);
  const owned = await ownedPaths(root, name, paths);
  const entry = await entryOf(root, owned, basePackage.version);
  await writeLock(root, { components: { ...lock.components, [name]: entry }, version: 1 }, ops);
}

/**
 * The paths a component owns on disk: every file in its folder, plus the registry's outside
 * files that the app holds.
 * @param {string} root - From a command; why: the app to read.
 * @param {string} name - From a command; why: the component folder to list.
 * @param {string[]} paths - From a command; why: the registry item's files.
 */
async function ownedPaths(root, name, paths) {
  const folder = folderOf(root, name);
  const inside = listFiles(folder, folder).map((file) => `${areaOf(name)}${file}`);
  const outside = paths.filter(
    (path) => !path.startsWith(areaOf(name)) && existsSync(join(root, path)),
  );
  return [...inside, ...outside];
}

/**
 * The names a component index file exports at runtime, sorted; a type-only export is left out.
 * @param {string} root - From pasteLines; why: `~/` is the app's `tinker/` folder.
 * @param {string} file - From pasteLines; why: an index file that was just written.
 * @param {Set<string>} [seen] - From starExports; why: a cycle of `export *` ends.
 */
function runtimeExports(root, file, seen = new Set()) {
  if (seen.has(file)) return [];
  seen.add(file);

  const names = new Set();
  for (const node of parseSource(file).program.body) {
    for (const name of statementNames(root, file, node, seen)) names.add(name);
  }
  return [...names].sort(byText);
}

/**
 * The runtime names one top-level statement adds: its own, or the ones a local star re-exports.
 * @param {string} root - From runtimeExports; why: `~/` is the app's `tinker/` folder.
 * @param {string} file - From runtimeExports; why: the file holding the statement.
 * @param {object} node - From runtimeExports; why: one top-level statement.
 * @param {Set<string>} seen - From runtimeExports; why: a cycle of stars ends.
 */
function statementNames(root, file, node, seen) {
  if (node.exportKind === "type") return [];
  if (node.type === "ExportAllDeclaration") return starExports(root, file, node, seen);
  if (node.type !== "ExportNamedDeclaration") return [];

  return declaredExports(node);
}

/**
 * The names `export * as x`, `export * from "./file"` and `export * from "~/file"` add.
 * @param {string} root - From runtimeExports; why: `~/` is the app's `tinker/` folder.
 * @param {string} file - From runtimeExports; why: the file holding the statement.
 * @param {object} node - From runtimeExports; why: one ExportAllDeclaration.
 * @param {Set<string>} seen - From runtimeExports; why: a cycle of stars ends.
 */
function starExports(root, file, node, seen) {
  if (node.exported) return [node.exported.name ?? node.exported.value];
  const target = localFile(root, file, node.source.value);
  if (target === null) return [];

  return runtimeExports(root, target, seen).filter((name) => name !== "default");
}

/**
 * The app file a module path names, or null for a package, a missing file, or one outside the app.
 * @param {string} root - From starExports; why: `~/` is the app's `tinker/` folder.
 * @param {string} from - From starExports; why: resolve a relative path from this file.
 * @param {string} name - From an export statement; why: the module path it names.
 */
function localFile(root, from, name) {
  const base = modulePath(root, from, name);
  if (base === null) return null;

  const ends = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"];
  return (
    ends.map((end) => base + end).find((path) => existsSync(path) && statSync(path).isFile()) ??
    null
  );
}

/**
 * Where a module path sits in the app; `~/` is `tinker/`, and nothing may leave the app.
 * @param {string} root - From localFile; why: the app folder to stay inside.
 * @param {string} from - From localFile; why: the file a relative path starts at.
 * @param {string} name - From an export statement; why: the module path it names.
 */
function modulePath(root, from, name) {
  const inside = (path) => path.startsWith(`${root}${sep}`);
  if (name.startsWith("~/")) {
    const path = resolve(root, "tinker", name.slice(2));
    return inside(path) ? path : null;
  }
  if (!name.startsWith(".")) return null;

  const path = resolve(dirname(from), name);
  return inside(path) ? path : null;
}

/**
 * The names one `export` statement binds, leaving out the type-only specifiers.
 * @param {object} node - From runtimeExports; why: one top-level statement.
 */
function declaredExports(node) {
  const declared = (node.declaration?.declarations ?? []).flatMap((item) =>
    namesOfPattern(item.id),
  );
  const specifiers = (node.specifiers ?? [])
    .filter((item) => item.exportKind !== "type")
    .map((item) => item.exported.name ?? item.exported.value);
  return [...declared, node.declaration?.id?.name, ...specifiers].filter(Boolean);
}

/**
 * The binding names a destructuring pattern names; a pattern it cannot name adds nothing.
 * @param {object} id - From declaredExports; why: the pattern a declaration binds.
 */
function namesOfPattern(id) {
  if (id === null || id === undefined) return [];
  if (id.type === "Identifier") return [id.name];
  if (id.type === "AssignmentPattern") return namesOfPattern(id.left);
  if (id.type === "RestElement") return namesOfPattern(id.argument);
  if (id.type === "ArrayPattern") return id.elements.flatMap((item) => namesOfPattern(item));
  if (id.type !== "ObjectPattern") return [];

  return id.properties.flatMap((field) =>
    namesOfPattern(field.type === "RestElement" ? field.argument : field.value),
  );
}

/** @param {string} file - From a member; why: `index.server.ts` imports as `index.server`. */
function moduleOf(name, file) {
  return `~/components/${name}${file === "index.ts" ? "" : `/${file.replace(/\.ts$/, "")}`}`;
}

/**
 * The lines the user pastes into cmds/*.ts, one import per index file that exports something.
 * @param {string} root - From addComponent; why: the copies that were just written.
 * @param {string[]} members - From addComponent; why: the new components, requires first.
 */
function pasteLines(root, members) {
  const lines = [];
  for (const name of members) {
    for (const file of ["index.ts", "index.server.ts"]) {
      const path = join(folderOf(root, name), file);
      if (!existsSync(path)) continue;

      const names = runtimeExports(root, path);
      if (names.length > 0) {
        lines.push(`import { ${names.join(", ")} } from "${moduleOf(name, file)}";`);
      }
    }
  }

  if (lines.length === 0) return [];
  return ["Paste what you use into cmds/*.ts (tinker add writes no wiring):", ...lines];
}

/**
 * Merge the npm deps of the items just copied into the app's package.json, keeping app specs.
 * @param {string} root - From a command; why: the app whose package.json changes.
 * @param {object[]} items - From a command; why: the items that landed.
 */
function mergeDeps(root, items) {
  const path = join(root, "package.json");
  const before = readFileSync(path, "utf8");
  const pkg = JSON.parse(before);
  const lines = new Set();

  for (const item of items) {
    const sections = [
      ["dependencies", item.dependencies ?? []],
      ["devDependencies", item.devDependencies ?? []],
    ];
    for (const [field, specs] of sections) {
      for (const spec of specs) {
        for (const line of keepDep(pkg, field, splitDep(spec))) lines.add(line);
      }
    }
  }

  const notes = [...lines];
  const after = `${JSON.stringify(pkg, null, 2)}\n`;
  if (after === before) return notes;

  writeFileSync(path, after);
  return [...notes, "run your package manager's install (npm install / pnpm install)"];
}

/**
 * Add one dep, or report the app's own spec when it already has one.
 * @param {object} pkg - From mergeDeps; why: the app's package.json.
 * @param {string} field - From mergeDeps; why: `dependencies` or `devDependencies`.
 * @param {{ name: string, spec: string }} dep - From splitDep; why: the dep to add.
 */
function keepDep(pkg, field, dep) {
  const section = pkg[field] ?? {};
  pkg[field] = section;
  if (section[dep.name] === undefined) {
    section[dep.name] = dep.spec;
    return [];
  }
  if (section[dep.name] === dep.spec) return [];
  return [`kept ${dep.name}@${section[dep.name]} (registry: ${dep.spec})`];
}

/**
 * Recover every component the closure touches, so a killed update never blocks an add.
 * @param {string} root - From addComponent; why: the app holding `.tinker/update`.
 * @param {object[]} members - From membersOf; why: the closure, requires first.
 * @param {object} ops - From addComponent; why: the fs ops a test can fail on purpose.
 */
async function recoverAll(root, members, ops) {
  const lines = [];
  for (const member of members) {
    lines.push(...(await recover(root, member.name, ops, [...member.files.keys()])));
  }
  return lines;
}

/**
 * The line a recovery prints for a component it put back.
 * @param {string} name - From a command; why: the component restored.
 */
function restoredMessage(name) {
  return `restored tinker/components/${name} from an interrupted update`;
}

/**
 * The line a recovery prints for a component whose swap finished but whose lock did not.
 * @param {string} name - From a command; why: the component the lock now records.
 */
function finishedMessage(name) {
  return `finished tinker/components/${name} from an interrupted update`;
}

/**
 * A member's files inside its own folder, as folder-relative paths.
 * @param {{ name: string, files: Map<string, string> }} member - From addComponent; why: its files.
 */
function insideOf(member) {
  const inside = new Map();
  for (const [path, content] of member.files) {
    if (path.startsWith(areaOf(member.name))) {
      inside.set(path.slice(areaOf(member.name).length), content);
    }
  }
  return inside;
}

/** @param {{ name: string, files: Map<string, string> }} member - From addComponent; why: its files. */
function outsideOf(member) {
  return [...member.files].filter(([path]) => !path.startsWith(areaOf(member.name)));
}

/**
 * `conflict:` lines for outside files that already exist with other bytes.
 * @param {string} root - From addComponent; why: the app to read.
 * @param {object[]} fresh - From addComponent; why: the members about to land.
 */
function conflictsOf(root, fresh) {
  const lines = [];
  for (const member of fresh) {
    for (const [path, content] of outsideOf(member)) {
      const file = join(root, path);
      if (existsSync(file) && readFileSync(file, "utf8") !== content) {
        lines.push(`conflict: ${path}`);
      }
    }
  }
  return lines;
}

/**
 * `missing requires:` lines for components this one needs but the app lacks.
 * @param {string} root - From checkComponents; why: the app to read.
 * @param {string} name - From checkComponents; why: the local component.
 */
function missingRequires(root, name) {
  const manifest = join(folderOf(root, name), "component.json");
  if (!existsSync(manifest)) return [];

  const requires = JSON.parse(readFileSync(manifest, "utf8")).requires ?? [];
  return requires
    .filter((required) => !existsSync(folderOf(root, required)))
    .map((required) => `missing requires: ${name} needs ${required}`);
}

/**
 * `interrupted update:` lines for temp folders a killed process left behind.
 * @param {string} root - From checkComponents; why: the app holding `.tinker/update`.
 */
function interruptedLines(root) {
  const work = join(root, ".tinker/update");
  if (!existsSync(work)) return [];

  const names = readdirSync(work)
    .filter((entry) => /\.(old|new|undo)$/.test(entry))
    .map((entry) => entry.replace(/\.(old|new|undo)$/, ""));
  return [...new Set(names)]
    .sort(byText)
    .map((name) => `interrupted update: ${name}; run tinker update ${name}`);
}

/**
 * The members of a closure, each with its item and its files.
 * @param {{ items: Map<string, object> }} catalog - From catalogOf; why: the item cache.
 * @param {string[]} closure - From closureOf; why: the members, requires first.
 */
async function membersOf(catalog, closure) {
  const members = [];
  for (const name of closure) {
    const item = await itemOf(catalog, name);
    members.push({ name, item, files: filesOf(item, name) });
  }
  return members;
}

/**
 * The members that still have to land, and a `kept` line for each one already here.
 * @param {string} root - From addComponent; why: the app to read.
 * @param {object[]} members - From membersOf; why: the closure.
 * @param {string[]} lines - From addComponent; why: where the kept lines go.
 */
function splitKept(root, members, lines) {
  const fresh = [];
  for (const member of members) {
    if (existsSync(folderOf(root, member.name))) {
      lines.push(`kept tinker/components/${member.name} (already here)`);
    } else {
      fresh.push(member);
    }
  }
  return fresh;
}

/**
 * Write one member's folder and its outside files.
 * @param {string} root - From addComponent; why: the app to write in.
 * @param {object[]} fresh - From splitKept; why: the members to land.
 * @param {object} ops - From addComponent; why: the fs ops a test can fail on purpose.
 */
async function copyAll(root, fresh, ops) {
  for (const member of fresh) {
    await swapFolder(root, member.name, insideOf(member), ops);
    for (const [path, content] of outsideOf(member)) await writeOutside(root, path, content, ops);
  }
}

/**
 * Record every component just copied in one lock write; a kept member keeps what it had.
 * @param {string} root - From addComponent; why: the app to write in.
 * @param {object[]} fresh - From splitKept; why: the members that landed.
 * @param {object} ops - From addComponent; why: the fs ops a test can fail on purpose.
 */
async function recordEntries(root, fresh, ops) {
  if (fresh.length === 0) return;

  const lock = await readLock(root);
  const components = { ...lock.components };
  for (const member of fresh) {
    components[member.name] = await entryOf(
      root,
      await ownedPaths(root, member.name, [...member.files.keys()]),
      basePackage.version,
    );
  }
  await writeLock(root, { components, version: 1 }, ops);
  clearWork(workOf(root));
}

/**
 * Write an outside file, skipping one that already holds the same bytes.
 * @param {string} root - From a command; why: the app to write in.
 * @param {string} path - From a member; why: the app-relative file.
 * @param {string} content - From the registry; why: the bytes.
 * @param {object} ops - From copyAll; why: the fs ops a test can fail on purpose.
 */
async function writeOutside(root, path, content, ops) {
  const file = join(root, path);
  if (existsSync(file) && readFileSync(file, "utf8") === content) return;

  await writeAtomic(file, content, ops);
}

/**
 * Add a component and every component it requires. No wiring, ever.
 * @param {string} root - From tinker add; why: the app to write in.
 * @param {string} name - From tinker add; why: the component asked for.
 * @param {string} base - From --registry or the release tag; why: where the files come from.
 */
export async function addComponent(root, name, base) {
  const catalog = await catalogOf(base);
  const closure = await closureOf(catalog, name);

  refuseStarterOnly(catalog, closure);
  const members = await membersOf(catalog, closure);
  const lines = await recoverAll(root, members, fsp);
  if (existsSync(folderOf(root, name))) {
    throw new Refusal([...lines, `${name} is already added; use tinker update ${name}`]);
  }

  const fresh = splitKept(root, members, lines);
  const conflicts = conflictsOf(root, fresh);
  if (conflicts.length > 0) throw new Refusal([...lines, ...conflicts]);

  await copyAll(root, fresh, fsp);
  await recordEntries(root, fresh, fsp);
  lines.push(
    ...mergeDeps(
      root,
      members.map((member) => member.item),
    ),
  );
  lines.push(
    ...pasteLines(
      root,
      fresh.map((member) => member.name),
    ),
  );
  lines.push(`tinker add: added ${fresh.map((member) => member.name).join(", ")}`);
  return { lines, code: 0 };
}

/**
 * Replace one component folder whole with the registry copy.
 * @param {string} root - From tinker update; why: the app to swap inside.
 * @param {string} name - From tinker update; why: the component to replace.
 * @param {string} base - From --registry or the release tag; why: where the files come from.
 * @param {{ force?: boolean, fs?: object }} [options] - From tinker update; why: --force, and the fs ops a test fails on purpose.
 */
export async function updateComponent(root, name, base, options = {}) {
  const ops = { ...fsp, ...options.fs };
  const catalog = await catalogOf(base);
  const item = await componentItem(catalog, name);

  refuseStarterOnly(catalog, [name]);
  const files = filesOf(item, name);
  const paths = [...files.keys()];
  const lines = await recover(root, name, ops, paths);
  if (!existsSync(folderOf(root, name))) {
    throw new Refusal([`${name} is not added; use tinker add ${name}`]);
  }

  await refuseEdits(root, name, files, { force: options.force, recovered: lines.length > 0 });
  await replaceWhole(root, name, { name, item, files }, ops, paths);

  lines.push(...mergeDeps(root, [item]));
  lines.push(
    `tinker update: replaced tinker/components/${name}; run tsc (npm run typecheck) to see breaks in your code`,
  );
  return { lines, code: 0 };
}

/**
 * Refuse an update the lock marks as edited, unless --force or a recovery just put the folder back.
 * @param {string} root - From updateComponent; why: the app to read.
 * @param {string} name - From updateComponent; why: the component to measure.
 * @param {Map<string, string>} files - From filesOf; why: the registry copy.
 * @param {{ force?: boolean, recovered: boolean }} options - From updateComponent; why: --force, and whether recovery ran.
 */
async function refuseEdits(root, name, files, options) {
  const lock = await readLock(root);
  const entry = lock.components[name];
  const diff = entry ? lockDiffOf(root, name, entry) : diffOf(root, name, files);
  const edits = entry ? diff.filter((line) => !alreadyNew(root, line, files)) : diff;
  if (edits.length === 0 || options.force || options.recovered) return;

  throw new Refusal([
    ...edits,
    `tinker update: ${name} has local edits; rerun with --force to replace them`,
  ]);
}

/**
 * Swap the folder in, write its outside files, then record the lock entry. Any failure undoes
 * the swap, so the old folder and the old lock entry both stay whole.
 * @param {string} root - From updateComponent; why: the app to write in.
 * @param {string} name - From updateComponent; why: the component to replace.
 * @param {object} member - From updateComponent; why: the registry item and its files.
 * @param {object} ops - From updateComponent; why: the fs ops a test can fail on purpose.
 * @param {string[]} paths - From updateComponent; why: the registry item's files.
 */
async function replaceWhole(root, name, member, ops, paths) {
  let moved = false;
  try {
    moved = await swapFolder(root, name, insideOf(member), ops);
    for (const [path, content] of outsideOf(member)) await writeOutside(root, path, content, ops);
    await recordEntry(root, name, ops, paths);
  } catch (error) {
    await undoSwap(root, name, ops, moved);
    throw error;
  }

  await dropOld(root, name, ops);
}

/**
 * Compare every copied component with the registry copy, and write nothing.
 * @param {string} root - From tinker check; why: the app to read.
 * @param {string} base - From --registry or the release tag; why: what to compare with.
 */
export async function checkComponents(root, base) {
  const catalog = await catalogOf(base);
  const lock = await readLock(root);
  const names = componentNames(root);
  const report = [];
  for (const name of names) report.push(...(await folderReport(root, name, catalog, lock)));
  for (const line of interruptedLines(root)) report.push({ line, finding: true });
  for (const line of missingComponents(names, lock)) report.push({ line, finding: true });

  const lines = report.map((entry) => entry.line);
  const findings = report.filter((entry) => entry.finding).length;
  if (findings === 0) {
    return {
      lines: [...lines, `tinker check: ${names.length} components match registry ${base}`],
      code: 0,
    };
  }
  return { lines: [...lines, `tinker check: ${findings} findings`], code: 1 };
}

/** @param {string} root - From checkComponents; why: the app whose folders to list. */
function componentNames(root) {
  const dir = join(root, "tinker/components");
  if (!existsSync(dir)) return [];

  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort(byText);
}

/**
 * One local component: its `edited:` findings, its note, and its `missing requires:` lines.
 * @param {string} root - From checkComponents; why: the app to read.
 * @param {string} name - From checkComponents; why: the folder to report.
 * @param {{ names: Set<string>, items: Map<string, object> }} catalog - From checkComponents; why: the index.
 * @param {{ components: Record<string, { files: Record<string, string>, start: string }> }} lock - From readLock; why: what was copied.
 */
async function folderReport(root, name, catalog, lock) {
  const entry = lock.components[name];
  const item = await checkedItemOrLine(catalog, name);
  if (typeof item === "string") return [{ line: item, finding: true }];
  if (item === null) return [{ line: `unknown component: ${name}`, finding: true }];
  if (catalog.metas.get(name)?.starterOnly === true) return starterReport(root, name, entry);

  return registryReport(root, name, item, entry);
}

/**
 * The item for a folder, or the one `bad item:` line that replaces a registry failure.
 * @param {{ names: Set<string>, items: Map<string, object> }} catalog - From checkComponents; why: the index.
 * @param {string} name - From folderReport; why: the folder to look up.
 */
async function checkedItemOrLine(catalog, name) {
  try {
    return await checkedItem(catalog, name);
  } catch (error) {
    return `bad item: ${name}: ${reasonOf(error)}`;
  }
}

/** @param {unknown} error - From a check; why: the one line that says what went wrong. */
function reasonOf(error) {
  if (error instanceof Refusal) return error.lines.join("; ");
  return error instanceof Error ? error.message : String(error);
}

/**
 * A starter-only component is copied with the starter's toolchain, so check measures it against
 * its lock entry only: no registry fence, no registry compare, no outdated advice.
 * @param {string} root - From folderReport; why: the app to read.
 * @param {string} name - From folderReport; why: the starter-only component.
 * @param {{ files: Record<string, string> }} [entry] - From readLock; why: what it was copied from.
 */
function starterReport(root, name, entry) {
  if (entry === undefined) {
    return [
      {
        line: `no lock entry: ${name} (starter-only; check compares it with the lock only)`,
        finding: false,
      },
    ];
  }

  return [
    ...lockDiffOf(root, name, entry).map((line) => ({ line: diffLine(line), finding: true })),
    ...missingRequires(root, name).map((line) => ({ line, finding: true })),
  ];
}

/**
 * A normal component: the lock it was copied from, then the registry it would come from now.
 * @param {string} root - From folderReport; why: the app to read.
 * @param {string} name - From folderReport; why: the component.
 * @param {object} item - From checkedItem; why: its registry item.
 * @param {{ files: Record<string, string>, start: string }} [entry] - From readLock; why: what it was copied from.
 */
function registryReport(root, name, item, entry) {
  try {
    const files = filesOf(item, name);
    const diff = entry ? lockDiffOf(root, name, entry) : diffOf(root, name, files);
    const notes = entry
      ? outdatedNote(name, entry, files)
      : [`no lock entry: ${name}; run tinker update ${name} to record it`];
    return [
      ...diff.map((line) => ({ line: diffLine(line), finding: true })),
      ...notes.map((line) => ({ line, finding: false })),
      ...missingRequires(root, name).map((line) => ({ line, finding: true })),
    ];
  } catch (error) {
    return [{ line: `bad item: ${name}: ${reasonOf(error)}`, finding: true }];
  }
}

/**
 * Rewrite one diff line for check: a `changed:`/`missing:`/`added:` line becomes `edited:`,
 * anything else (a `bad lock path:`) stays as it is.
 * @param {string} line - From a diff; why: one line to print.
 */
function diffLine(line) {
  return /^(changed|missing|added): /.test(line) ? editedLine(line) : line;
}

/**
 * `outdated:` when the lock and the registry differ in paths or hashes; a `start` alone is fine.
 * @param {string} name - From folderReport; why: the component to name.
 * @param {{ files: Record<string, string> }} entry - From readLock; why: what the folder came from.
 * @param {Map<string, string>} files - From folderReport; why: the registry item's bytes.
 */
function outdatedNote(name, entry, files) {
  if (sameFiles(entry.files ?? {}, registryHashes(files))) return [];

  return [`outdated: ${name} (lock start ${entry.start}; run tinker update ${name})`];
}

/**
 * `missing component:` lines for lock entries whose folder is gone.
 * @param {string[]} names - From checkComponents; why: the folders that exist.
 * @param {{ components: Record<string, object> }} lock - From readLock; why: the recorded entries.
 */
function missingComponents(names, lock) {
  const present = new Set(names);
  return Object.keys(lock.components)
    .filter((name) => !present.has(name))
    .sort(byText)
    .map((name) => `missing component: ${name} is in tinker/components.lock`);
}

/**
 * The item for a local folder, or null when check should call it unknown.
 * @param {{ names: Set<string>, items: Map<string, object> }} catalog - From catalogOf; why: the index.
 * @param {string} name - From checkComponents; why: the local folder.
 */
async function checkedItem(catalog, name) {
  try {
    return await componentItem(catalog, name);
  } catch (error) {
    if (error instanceof Refusal) return null;
    throw error;
  }
}
