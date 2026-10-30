import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { dirname, join } from "node:path";

import { listFiles } from "./paths.mjs";
import { readRegistryJson } from "./registry.mjs";
import { parseSource } from "./source.mjs";

/** A refusal: the lines to print and exit 1, with no write behind it. */
export class Refusal {
  /** @param {string[]} lines - From a command; why: what the user reads. */
  constructor(lines) {
    this.lines = lines;
  }
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
  if (!catalog.names.has(name)) throw new Refusal([`unknown component: ${name}`]);

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
    if (path === null) throw new Refusal([`bad target ${file.target} in ${name}`]);
    files.set(path, file.content);
  }
  return files;
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
async function writeFolder(root, name, files, ops) {
  const target = folderOf(root, name);
  const work = join(root, ".tinker/update");
  const fresh = join(work, `${name}.new`);
  const old = join(work, `${name}.old`);

  await ops.mkdir(work, { recursive: true });
  await ops.mkdir(dirname(target), { recursive: true });
  try {
    await fillFolder(fresh, files, ops);
    if (!existsSync(target)) {
      await ops.rename(fresh, target);
      return;
    }

    await ops.rename(target, old);
    try {
      await ops.rename(fresh, target);
    } catch (error) {
      await ops.rename(old, target);
      await ops.rm(fresh, { recursive: true, force: true });
      throw error;
    }

    await ops.rm(old, { recursive: true, force: true });
  } finally {
    clearWork(work);
  }
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
 * @param {object} ops - From a command; why: the fs ops a test can fail on purpose.
 */
async function recover(root, name, ops) {
  const work = join(root, ".tinker/update");
  const target = folderOf(root, name);
  const old = join(work, `${name}.old`);
  const fresh = join(work, `${name}.new`);
  let restored = false;

  if (existsSync(old) && !existsSync(target)) {
    await ops.mkdir(dirname(target), { recursive: true });
    await ops.rename(old, target);
    restored = true;
  } else if (existsSync(old)) {
    await ops.rm(old, { recursive: true, force: true });
  }

  if (existsSync(fresh)) await ops.rm(fresh, { recursive: true, force: true });
  clearWork(work);
  return restored;
}

/**
 * The names a component index file exports at runtime, sorted; a type-only export is left out.
 * @param {string} file - From pasteLines; why: an index file that was just written.
 */
function runtimeExports(file) {
  const names = new Set();
  for (const node of parseSource(file).program.body) {
    if (node.type !== "ExportNamedDeclaration" || node.exportKind === "type") continue;
    for (const name of declaredExports(node)) names.add(name);
  }
  return [...names].sort(byText);
}

/**
 * The names one `export` statement binds, leaving out the type-only specifiers.
 * @param {object} node - From runtimeExports; why: one top-level statement.
 */
function declaredExports(node) {
  const declared = (node.declaration?.declarations ?? []).flatMap((item) =>
    item.id.type === "ObjectPattern"
      ? item.id.properties.map((field) => field.value.name)
      : [item.id.name],
  );
  const specifiers = (node.specifiers ?? [])
    .filter((item) => item.exportKind !== "type")
    .map((item) => item.exported.name ?? item.exported.value);
  return [...declared, node.declaration?.id?.name, ...specifiers].filter(Boolean);
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

      const names = runtimeExports(path);
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
  const lines = [];

  for (const item of items) {
    const sections = [
      ["dependencies", item.dependencies ?? []],
      ["devDependencies", item.devDependencies ?? []],
    ];
    for (const [field, specs] of sections) {
      for (const spec of specs) lines.push(...keepDep(pkg, field, splitDep(spec)));
    }
  }

  const after = `${JSON.stringify(pkg, null, 2)}\n`;
  if (after === before) return lines;

  writeFileSync(path, after);
  return [...lines, "run your package manager's install (npm install / pnpm install)"];
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
 * The line a recovery prints for a component it put back.
 * @param {string} name - From a command; why: the component restored.
 */
function restoredMessage(name) {
  return `restored tinker/components/${name} from an interrupted update`;
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
    .filter((entry) => /\.(old|new)$/.test(entry))
    .map((entry) => entry.replace(/\.(old|new)$/, ""));
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
 */
async function copyAll(root, fresh) {
  for (const member of fresh) {
    await writeFolder(root, member.name, insideOf(member), fsp);
    for (const [path, content] of outsideOf(member)) await writeOutside(root, path, content);
  }
}

/**
 * Write an outside file, skipping one that already holds the same bytes.
 * @param {string} root - From a command; why: the app to write in.
 * @param {string} path - From a member; why: the app-relative file.
 * @param {string} content - From the registry; why: the bytes.
 */
async function writeOutside(root, path, content) {
  const file = join(root, path);
  if (existsSync(file) && readFileSync(file, "utf8") === content) return;

  await writeAtomic(file, content, fsp);
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
  const restored = await recover(root, name, fsp);
  if (existsSync(folderOf(root, name))) {
    throw new Refusal([`${name} is already added; use tinker update ${name}`]);
  }

  const lines = restored ? [restoredMessage(name)] : [];
  const fresh = splitKept(root, members, lines);
  const conflicts = conflictsOf(root, fresh);
  if (conflicts.length > 0) throw new Refusal([...lines, ...conflicts]);

  await copyAll(root, fresh);
  lines.push(
    ...mergeDeps(
      root,
      fresh.map((member) => member.item),
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
  const restored = await recover(root, name, ops);
  if (!existsSync(folderOf(root, name))) {
    throw new Refusal([`${name} is not added; use tinker add ${name}`]);
  }

  const member = { name, item, files: filesOf(item, name) };
  const diff = diffOf(root, name, member.files);
  if (diff.length > 0 && !options.force && !restored) {
    throw new Refusal([
      ...diff,
      `tinker update: ${name} has local edits; rerun with --force to replace them`,
    ]);
  }

  await writeFolder(root, name, insideOf(member), ops);
  for (const [path, content] of outsideOf(member)) await writeOutside(root, path, content);

  const lines = restored ? [restoredMessage(name)] : [];
  lines.push(...mergeDeps(root, [item]));
  lines.push(
    `tinker update: replaced tinker/components/${name}; run tsc (npm run typecheck) to see breaks in your code`,
  );
  return { lines, code: 0 };
}

/**
 * Compare every copied component with the registry copy, and write nothing.
 * @param {string} root - From tinker check; why: the app to read.
 * @param {string} base - From --registry or the release tag; why: what to compare with.
 */
export async function checkComponents(root, base) {
  const catalog = await catalogOf(base);
  const dir = join(root, "tinker/components");
  const names = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name)
        .sort(byText)
    : [];
  const lines = [];

  for (const name of names) {
    const item = await checkedItem(catalog, name);
    if (item === null) {
      lines.push(`unknown component: ${name}`);
      continue;
    }
    lines.push(...diffOf(root, name, filesOf(item, name)).map(editedLine));
    lines.push(...missingRequires(root, name));
  }

  lines.push(...interruptedLines(root));
  if (lines.length === 0) {
    return { lines: [`tinker check: ${names.length} components match registry ${base}`], code: 0 };
  }
  return { lines: [...lines, `tinker check: ${lines.length} findings`], code: 1 };
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
