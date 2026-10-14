import { existsSync } from "node:fs";
import { join, relative } from "node:path";

import { readItemModules } from "./item-modules.mjs";
import { appFiles, pick } from "./named.mjs";
import { exportsOf } from "./source.mjs";

const singles = {
  server: ["database", "auth", "readAccount", "bootstrap"],
  client: ["records", "readBatch", "readBootstrap", "readSnapshot", "streamMessage"],
};

const roles = {
  server: ["extensions", "settings", ...singles.server],
  client: ["extensions", ...singles.client],
};

/** The role's exact file name separates server code from client code. */
function roleName(name, side) {
  return `${name}${side === "server" ? ".server" : ""}.ts`;
}

/** Only these file names take part in composition; other item code is private. */
export function isRoleFile(file) {
  const segments = file.split("/");
  if (segments.length !== 4 || segments[0] !== "src" || segments[1] !== "items") return false;
  return Object.entries(roles).some(([side, names]) =>
    names.some((name) => segments[3] === roleName(name, side)),
  );
}

/** Prepare must know the user seam's names before composing lists or choosing owners. */
function readExports(root, path) {
  const { names, open } = exportsOf(path, new Set(), root);
  const problems = open
    ? [
        `${relative(root, path)}:1 has an export * whose names prepare cannot read; use explicit named exports`,
      ]
    : [];
  return { names, problems };
}

/** Read manifests and file names, never parse or load an item's role code. */
export function readItems(root, side) {
  const items = [];
  const owners = new Map();
  const { folders, problems } = readItemModules(root, isRoleFile);

  for (const folder of folders) {
    for (const name of roles[side].filter((name) => folder.files.has(roleName(name, side)))) {
      const file = `src/items/${folder.name}/${roleName(name, side)}`;
      items.push({
        name,
        file,
        ancestors: [...folder.ancestors].map((name) => `src/items/${name}/settings.server.ts`),
      });
      if (!singles[side].includes(name)) continue;
      if (owners.has(name)) {
        problems.push(`${name}: ${owners.get(name)} and ${file} both own ${name}`);
      } else owners.set(name, file);
    }
  }
  return { items, owners, problems };
}

/** Doctor reports composition problems once, even if generated files are stale. */
export function joinProblems(root) {
  const seams = appFiles.filter(
    (entry) => entry.alias.startsWith("#tinker/app") && existsSync(join(root, entry.file)),
  );
  return [
    ...new Set([
      ...seams.flatMap((entry) => readExports(root, join(root, entry.file)).problems),
      ...["server", "client"].flatMap((side) => readItems(root, side).problems),
    ]),
  ];
}

/** Part reads may come from an item role; the user's seam still wins. */
export function seamExports(root, file, name) {
  if (existsSync(join(root, file))) {
    const own = readExports(root, join(root, file));
    if (own.problems.length > 0) return false;
    if (own.names.has(name)) return true;
  }
  const side = file.endsWith(".server.ts") ? "server" : "client";
  return readItems(root, side).owners.has(name);
}

/** Named typed constants keep single-role inference and check settings callability. */
function appendRoles(lines, modules, own) {
  for (const item of modules) {
    const type = item.name[0].toUpperCase() + item.name.slice(1);
    lines.push(
      item.name === "settings"
        ? `const ${item.id}: App.Settings = ${item.id}Export;`
        : `const ${item.id} = ${item.id}Export satisfies App.${type};`,
    );
    if (own.names.has(item.name) && !["extensions", "settings"].includes(item.name)) {
      lines.push(`void ${item.id};`);
    }
  }
  lines.push("");
}

/** Nested lists preserve extension and binding identities; the user is last. */
function appendLists(lines, modules, own, side) {
  const extensions = modules.filter((item) => item.name === "extensions").map((item) => item.id);
  if (own.names.has("extensions")) extensions.push("own.extensions");
  lines.push(`export const extensions = [${extensions.join(", ")}] as const;`);
  if (side !== "server") return;

  const settings = modules.filter((item) => item.name === "settings");
  if (own.names.has("settings")) lines.push("const ownSettings: App.Settings = own.settings;");
  lines.push("export function settings(env: App.Env): App.Bindings {");
  const lists = [];
  if (settings.length > 1) {
    lines.push("  const items = joinSettings([");
    for (const item of settings) {
      lines.push(
        `    { file: ${JSON.stringify(item.file)}, requires: ${JSON.stringify(item.ancestors)}, bindings: ${item.id}(env) },`,
      );
    }
    lines.push("  ]);");
    lists.push("items");
  } else lists.push(...settings.map((item) => `${item.id}(env)`));
  if (own.names.has("settings")) lists.push("ownSettings(env)");
  lines.push(`  return [${lists.join(", ")}];`, "}");
}

/** Only known single roles are exposed; each user name takes precedence. */
function appendSingles(lines, modules, own, ownModule, side) {
  for (const name of singles[side]) {
    if (own.names.has(name)) lines.push(`export { ${name} } from ${JSON.stringify(ownModule)};`);
    else {
      const owner = modules.find((item) => item.name === name);
      if (owner) lines.push(`export { ${owner.id} as ${name} };`);
    }
  }
}

/** Runtime tag checks are imported only when two item settings could collide. */
function appendImports(lines, modules, own, ownModule, side, base) {
  if (side === "server" && modules.filter((item) => item.name === "settings").length > 1) {
    lines.push(
      `import { joinSettings } from ${JSON.stringify(join(base, "lib/item-settings.mjs"))};`,
    );
  }
  for (const item of modules) {
    lines.push(`import ${item.id}Export from ${JSON.stringify(item.module)};`);
  }
  const readsOwn = own.names.has("extensions") || (side === "server" && own.names.has("settings"));
  if (readsOwn) lines.push(`import * as own from ${JSON.stringify(ownModule)};`);
  lines.push("");
}

/** Generate explicit default imports; no roles passes on the original seam in one line. */
export function appFile(root, base, side) {
  const entry = appFiles.find(
    (item) => item.alias === `#tinker/app${side === "server" ? ".server" : ""}`,
  );
  const ownPath = pick(root, base, entry);
  const ownModule =
    ownPath === join(root, entry.file)
      ? `@/${entry.file.slice(4, -3)}`
      : ownPath.replace(/\.ts$/, "");

  const read = readItems(root, side);
  const own = readExports(root, ownPath);
  const problems = [...read.problems, ...own.problems];
  if (problems.length > 0) throw new Error(problems.join("\n"));
  if (read.items.length === 0) return `export * from ${JSON.stringify(ownModule)};\n`;

  const modules = read.items.map((item, index) => ({
    ...item,
    id: `item${index}${item.name[0].toUpperCase()}${item.name.slice(1)}`,
    module: `@/${item.file.slice(4, -3)}`,
  }));
  const lines = [
    "/** GENERATED by tinker prepare. Edit src/items or your own seam. */",
    `import type { App } from ${JSON.stringify(join(base, "lib/app"))};`,
  ];
  appendImports(lines, modules, own, ownModule, side, base);

  appendRoles(lines, modules, own);
  appendLists(lines, modules, own, side);
  lines.push("");
  appendSingles(lines, modules, own, ownModule, side);
  return `${lines.join("\n")}\n`;
}
