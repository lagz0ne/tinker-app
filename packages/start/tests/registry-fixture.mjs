import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { onTestFinished } from "vite-plus/test";

import { baseDir, listFiles } from "../lib/paths.mjs";

/** The bin a test spawns, so a command test runs the real entry. */
export const bin = join(baseDir, "bin/tinker.mjs");

/** A temp folder, removed when the test ends. @param {string} [prefix] - From a test; why: name it. */
export function tempDir(prefix = "tinker-lock-") {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Write `target -> text` pairs under `root`; `~/` is the app root.
 * @param {string} root - From a test; why: the app or registry folder to write in.
 * @param {Record<string, string>} files - From a test; why: what to write.
 */
export function writeFiles(root, files) {
  for (const [target, text] of Object.entries(files)) {
    const file = join(root, target.replace(/^~\//, ""));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

/** @param {object} [extra] - From a test; why: dependencies to start with. */
export function packageJson(extra = {}) {
  const pkg = { name: "app", version: "0.0.0", private: true, type: "module", ...extra };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/** @param {Record<string, string>} [files] - From a test; why: what the app holds. */
export function app(files = {}) {
  const root = tempDir();
  writeFiles(root, { "package.json": packageJson(), ...files });
  return root;
}

/** @param {string} root - From a test; why: the app. @param {string} file - From a test; why: the file. */
export function read(root, file) {
  return readFileSync(join(root, file.replace(/^~\//, "")), "utf8");
}

/** @param {Buffer | string} bytes - From a hash; why: the sha256 hex the lock records. */
export function sha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** @param {string} root - From a test; why: the app. @param {string} file - From a test; why: the file to hash. */
export function shaFile(root, file) {
  return sha(readFileSync(join(root, file.replace(/^~\//, ""))));
}

/** @param {string} top - From a test; why: hash every file under it. */
export function snapshot(top) {
  return Object.fromEntries(
    listFiles(top, top)
      .sort()
      .map((file) => [file, sha(readFileSync(join(top, file)))]),
  );
}

/**
 * Deep-sorted JSON text: every object's keys in order, 2 spaces, no newline.
 * @param {unknown} value - From a test; why: the lock as the contract writes it.
 */
export function canonical(value) {
  const sort = (item) => {
    if (Array.isArray(item)) return item.map(sort);
    if (item === null || typeof item !== "object") return item;
    return Object.fromEntries(
      Object.keys(item)
        .sort()
        .map((key) => [key, sort(item[key])]),
    );
  };
  return JSON.stringify(sort(value), null, 2);
}

/**
 * The lock text for a hand-built lock.
 * @param {Record<string, { files: Record<string, string>, start: string }>} components - From a test; why: the entries.
 */
export function lockText(components) {
  return `${canonical({ components, version: 1 })}\n`;
}

/**
 * The hashes a fixture file map gives the paths under `top`.
 * @param {Record<string, string>} files - From a fixture; why: target -> content.
 * @param {string} top - From a test; why: the folder those files land in.
 */
export function hashesOf(files, top) {
  const found = {};
  for (const [target, content] of Object.entries(files)) {
    const file = target.replace(/^~\//, "");
    if (file.startsWith(`${top}/`)) found[file] = sha(Buffer.from(content));
  }
  return found;
}

/**
 * Run the bin in `root`.
 * @param {string} root - From a test; why: the app is the cwd.
 * @param {...string} args - From a test; why: the command and its flags.
 */
export function tinker(root, ...args) {
  const run = spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: "utf8" });
  const out = run.stdout.trim();
  return { code: run.status, out, lines: out === "" ? [] : out.split("\n") };
}

/**
 * A component folder's files, with `index.ts` exporting `<name>Value`.
 * @param {string} name - From a fixture item; why: the component's name.
 * @param {string[]} [requires] - From a fixture item; why: what its component.json lists.
 * @param {Record<string, string>} [extra] - From a fixture item; why: files to add.
 */
export function componentFiles(name, requires = [], extra = {}) {
  const list = requires.map((item) => `"${item}"`).join(", ");
  return {
    [`~/tinker/components/${name}/component.json`]: `{ "requires": [${list}] }\n`,
    [`~/tinker/components/${name}/index.ts`]: `export const ${name}Value = "${name}";\n`,
    ...extra,
  };
}

/** Update test component `u`, version 1: two files plus one the next version drops. */
export const uV1 = {
  "~/tinker/components/u/component.json": '{ "requires": [] }\n',
  "~/tinker/components/u/index.ts": "export const uVersion = 1;\n",
  "~/tinker/components/u/stale.ts": "export const stale = true;\n",
};

/** Update test component `u`, version 2: one changed file and one new file. */
export const uV2 = {
  "~/tinker/components/u/component.json": '{ "requires": [] }\n',
  "~/tinker/components/u/index.ts": "export const uVersion = 2;\n",
  "~/tinker/components/u/fresh.ts": "export const fresh = true;\n",
};

/** The outside-file component, version 1. */
export const mV1 = {
  "~/tinker/components/m/component.json": '{ "requires": [] }\n',
  "~/tinker/components/m/index.ts": 'export const mValue = "m";\n',
  "~/drizzle/1_m/migration.sql": "-- 1_m\n",
};

/** The outside-file component, version 2: the migration text changes. */
export const mV2 = {
  "~/tinker/components/m/component.json": '{ "requires": [] }\n',
  "~/tinker/components/m/index.ts": 'export const mValue = "m2";\n',
  "~/drizzle/1_m/migration.sql": "-- 1_m v2\n",
};

/** The fixture registry's items: a -> b -> c, an outside file, and `u` for version bumps. */
export const items = {
  a: { files: componentFiles("a", ["b"]) },
  b: { files: componentFiles("b", ["c"]) },
  c: { files: componentFiles("c") },
  m: { files: mV1 },
  u: { files: uV1 },
};

/**
 * One item JSON in the fixture registry.
 * @param {string} dir - From makeRegistry; why: the registry folder.
 * @param {string} name - From a fixture item; why: the item's name.
 * @param {{ files: Record<string, string>, dependencies?: string[] }} spec - From items; why: its files.
 */
export function writeItem(dir, name, spec) {
  const item = {
    name,
    type: "registry:component",
    files: Object.entries(spec.files).map(([target, content]) => ({
      target,
      type: "registry:file",
      content,
    })),
    ...(spec.dependencies ? { dependencies: spec.dependencies } : {}),
  };
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(item, null, 2)}\n`);
}

/**
 * A fixture registry folder: `registry.json` plus one `<name>.json` per item.
 * @param {Record<string, object>} [tweaks] - From a test; why: items to change or add.
 */
export function makeRegistry(tweaks = {}) {
  const dir = tempDir("tinker-registry-");
  const specs = { ...items, ...tweaks };
  const index = {
    name: "tinker-test",
    items: Object.keys(specs).map((name) => ({ name, type: "registry:component" })),
  };

  writeFileSync(join(dir, "registry.json"), `${JSON.stringify(index, null, 2)}\n`);
  for (const [name, spec] of Object.entries(specs)) writeItem(dir, name, spec);
  return dir;
}

/**
 * Change one item in a registry already built: a new version.
 * @param {string} dir - From a test; why: the registry folder.
 * @param {string} name - From a test; why: the item to replace.
 * @param {{ files: Record<string, string> }} spec - From a test; why: the new shape.
 */
export function setItem(dir, name, spec) {
  writeItem(dir, name, spec);
}
