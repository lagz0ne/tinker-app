import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const itemName = /^[a-z][a-z0-9-]*$/;

/** JSON is the only item content prepare reads; participating items must declare it. */
function readRequires(root, name, problems) {
  const file = `src/items/${name}/item.json`;
  if (!existsSync(join(root, file))) {
    problems.push(`src/items/${name}: missing item.json; add ${file} with { "requires": [] }`);
    return [];
  }
  let value;
  try {
    value = JSON.parse(readFileSync(join(root, file), "utf8"));
  } catch {
    problems.push(`${file}: invalid JSON`);
    return [];
  }

  return manifestRequires(value, file, problems);
}

/** Validate the manifest once at the file boundary; unknown keys are never ignored. */
function manifestRequires(value, file, problems) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    problems.push(`${file}: expected an object with only requires`);
    return [];
  }
  for (const key of Object.keys(value)) {
    if (key !== "requires") {
      problems.push(`${file}: unknown key "${key}"; only requires is allowed`);
    }
  }
  return dependencyNames(Object.hasOwn(value, "requires") ? value.requires : [], file, problems);
}

/** Duplicate declarations have the same meaning as one edge. */
function dependencyNames(requires, file, problems) {
  if (
    !Array.isArray(requires) ||
    requires.some((name) => typeof name !== "string" || !itemName.test(name))
  ) {
    problems.push(`${file}: requires must be an array of item names`);
    return [];
  }
  return [...new Set(requires)].sort((a, b) => a.localeCompare(b));
}

/** Follow unfinished dependencies until one repeats; the repeated path closes the cycle. */
function cyclePath(pending) {
  const path = [];
  let name = [...pending.keys()].sort((a, b) => a.localeCompare(b))[0];
  while (!path.includes(name)) {
    path.push(name);
    name = pending.get(name).requires.find((dependency) => pending.has(dependency));
  }
  return [...path.slice(path.indexOf(name)), name]
    .map((name) => `src/items/${name}/item.json`)
    .join(" -> ");
}

/** Kahn's ready set is re-sorted after each item, so newly ready names compete with old ones. */
function sortModules(folders, problems) {
  const pending = new Map(folders.map((folder) => [folder.name, folder]));
  const counts = new Map(folders.map((folder) => [folder.name, folder.requires.length]));
  const ready = folders
    .filter((folder) => folder.requires.length === 0)
    .map((folder) => folder.name);
  const sorted = [];

  while (ready.length > 0) {
    ready.sort((a, b) => a.localeCompare(b));
    const folder = pending.get(ready.shift());
    folder.ancestors = new Set(folder.requires);
    for (const dependency of folder.requires) {
      for (const ancestor of sorted.find((item) => item.name === dependency).ancestors) {
        folder.ancestors.add(ancestor);
      }
    }
    sorted.push(folder);
    pending.delete(folder.name);

    for (const next of pending.values()) {
      if (!next.requires.includes(folder.name)) continue;
      const count = counts.get(next.name) - 1;
      counts.set(next.name, count);
      if (count === 0) ready.push(next.name);
    }
  }
  if (pending.size > 0) problems.push(`item requires cycle: ${cyclePath(pending)}`);
  return sorted;
}

/** Folders containing only helper files have no composition role. */
function readFolder(root, name, isRoleFile, problems) {
  const files = new Set(
    readdirSync(join(root, "src/items", name), { withFileTypes: true })
      .filter((file) => file.isFile())
      .map((file) => file.name),
  );
  const participates =
    [...files].some((file) => isRoleFile(`src/items/${name}/${file}`)) ||
    ["item.json", "index.ts", "index.server.ts"].some((file) => files.has(file));
  if (!participates) return [];

  if (!itemName.test(name)) {
    const renamed = name.replace(/^\d+-/, "");
    problems.push(
      /^\d+-/.test(name)
        ? `src/items/${name}: rename to src/items/${renamed} and declare requires in item.json`
        : `src/items/${name}: item names must match [a-z][a-z0-9-]*`,
    );
    return [];
  }
  return [{ name, files, requires: readRequires(root, name, problems) }];
}

/** Self and missing edges fail before sorting, so the cycle walk only sees known dependencies. */
function checkDependencies(folders, problems) {
  const names = new Set(folders.map((folder) => folder.name));
  for (const folder of folders) {
    for (const dependency of folder.requires) {
      const file = `src/items/${folder.name}/item.json`;
      if (dependency === folder.name) {
        problems.push(`${file}: cannot require itself (src/items/${folder.name})`);
      } else if (!names.has(dependency)) {
        problems.push(`${file}: requires missing item src/items/${dependency}; shadcn add it`);
      }
    }
  }
}

/** Role detection is supplied by joins, keeping manifests independent of server/client selection. */
export function readItemModules(root, isRoleFile) {
  const dir = join(root, "src/items");
  const entries = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [];
  const problems = [];
  const folders = entries
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => readFolder(root, entry.name, isRoleFile, problems));

  checkDependencies(folders, problems);
  const ordered = problems.length === 0 ? sortModules(folders, problems) : [];
  return { folders: ordered, declared: folders, problems };
}
