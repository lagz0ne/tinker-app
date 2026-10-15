import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { rules } from "./part-env.mjs";

const componentName = /^[a-z][a-z0-9-]*$/;

/** Doctor reads requires from each component manifest. */
function readManifest(root, name, problems) {
  const file = `tinker/components/${name}/component.json`;
  if (!existsSync(join(root, file))) {
    problems.push(
      `tinker/components/${name}: missing component.json; add ${file} with { "requires": [] }`,
    );
    return { requires: [] };
  }
  let value;
  try {
    value = JSON.parse(readFileSync(join(root, file), "utf8"));
  } catch {
    problems.push(`${file}: invalid JSON`);
    return { requires: [] };
  }

  const requires = manifestRequires(value, file, problems);
  const env = manifestEnv(value, file, problems);
  return { requires, ...(env === undefined ? {} : { env }) };
}

/** Validate the manifest once at the file boundary; unknown keys are never ignored. */
function manifestRequires(value, file, problems) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    problems.push(`${file}: expected an object with only requires and env`);
    return [];
  }
  for (const key of Object.keys(value)) {
    if (!["requires", "env"].includes(key)) {
      problems.push(`${file}: unknown key "${key}"; only requires and env are allowed`);
    }
  }
  return dependencyNames(Object.hasOwn(value, "requires") ? value.requires : [], file, problems);
}

/** Env is data only; doctor never imports a component's runtime code. */
function manifestEnv(value, file, problems) {
  if (!value || !Object.hasOwn(value, "env")) return undefined;
  const env = value.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    problems.push(`${file}: env must be an object of env keys`);
    return {};
  }

  return checkedEnv(env, file, problems);
}

function checkedEnv(env, file, problems) {
  const checked = {};
  for (const [key, row] of Object.entries(env)) {
    const before = problems.length;
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) problems.push(`${file}: invalid env key "${key}"`);
    envRule(row, `${file} env.${key}`, problems);
    if (problems.length === before) checked[key] = row;
  }
  return checked;
}

function envRule(row, at, problems) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    problems.push(`${at}: expected default and rule fields`);
    return;
  }

  for (const key of Object.keys(row)) {
    if (!["default", "rule"].includes(key)) problems.push(`${at}: unknown key "${key}"`);
  }
  envDefaults(row, at, problems);
}

function envDefaults(row, at, problems) {
  if (Object.hasOwn(row, "default") && typeof row.default !== "string") {
    problems.push(`${at}: default must be a string`);
  }
  if (Object.hasOwn(row, "rule")) {
    if (typeof row.rule !== "string" || !Object.hasOwn(rules, row.rule)) {
      problems.push(`${at}: rule must name ${Object.keys(rules).join(", ")}`);
    }
  }
}

/** Duplicate declarations have the same meaning as one edge. */
function dependencyNames(requires, file, problems) {
  if (
    !Array.isArray(requires) ||
    requires.some((name) => typeof name !== "string" || !componentName.test(name))
  ) {
    problems.push(`${file}: requires must be an array of component names`);
    return [];
  }
  return [...new Set(requires)].sort((a, b) => a.localeCompare(b));
}

/** Doctor checks cycles without choosing a wiring order. */
function checkCycles(folders, problems) {
  const modules = new Map(folders.map((folder) => [folder.name, folder]));
  const seen = new Set();
  const path = [];

  function visit(name) {
    if (path.includes(name)) {
      const cycle = [...path.slice(path.indexOf(name)), name]
        .map((entry) => `tinker/components/${entry}/component.json`)
        .join(" -> ");
      problems.push(`component requires cycle: ${cycle}`);
      return;
    }
    if (seen.has(name)) return;

    path.push(name);
    for (const dependency of modules.get(name).requires) visit(dependency);
    path.pop();
    seen.add(name);
  }

  for (const folder of folders) visit(folder.name);
}

/** Every non-empty component folder declares its imports. */
function readFolder(root, name, problems) {
  const entries = readdirSync(join(root, "tinker/components", name), { withFileTypes: true });
  const files = new Set(entries.filter((file) => file.isFile()).map((file) => file.name));
  if (entries.length === 0) return [];

  if (!componentName.test(name)) {
    const renamed = name.replace(/^\d+-/, "");
    problems.push(
      /^\d+-/.test(name)
        ? `tinker/components/${name}: rename to tinker/components/${renamed} and declare requires in component.json`
        : `tinker/components/${name}: component names must match [a-z][a-z0-9-]*`,
    );
    return [];
  }
  return [{ name, files, ...readManifest(root, name, problems) }];
}

/** Self and missing edges fail before the cycle check, so the cycle walk only sees known dependencies. */
function checkDependencies(folders, problems) {
  const names = new Set(folders.map((folder) => folder.name));
  for (const folder of folders) {
    for (const dependency of folder.requires) {
      const file = `tinker/components/${folder.name}/component.json`;
      if (dependency === folder.name) {
        problems.push(`${file}: cannot require itself (tinker/components/${folder.name})`);
      } else if (!names.has(dependency)) {
        problems.push(
          `${file}: requires missing component tinker/components/${dependency}; shadcn add it`,
        );
      }
    }
  }
}

/** Doctor checks manifests and cycles; it never chooses the app's wiring order. */
export function readComponentModules(root) {
  const dir = join(root, "tinker/components");
  const entries = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [];
  const problems = [];
  const folders = entries
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => readFolder(root, entry.name, problems));

  checkDependencies(folders, problems);
  if (problems.length === 0) checkCycles(folders, problems);
  return { declared: folders, problems };
}
