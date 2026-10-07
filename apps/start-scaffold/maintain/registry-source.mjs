import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, posix, resolve } from "node:path";

import { releaseUrls } from "../../../packages/start/lib/release.mjs";

export const app = resolve(import.meta.dirname, "..");
export const root = resolve(app, "../..");

/** Examples may add files, but never replace the app template or another item's files. */
function checkTargets(registry) {
  const protectedFiles = new Set([
    ...registry.items.find((item) => item.name === "app").files.map((file) => file.target),
    "~/package.json",
    "~/vite.config.ts",
    "~/vite.config.mts",
    "~/tsconfig.json",
    "~/src/lib/tinker.ts",
    "~/src/lib/tinker.server.ts",
  ]);
  const owners = new Map();
  for (const item of registry.items) {
    for (const file of item.files) {
      assert.ok(file.target.startsWith("~/") && !file.target.includes(".."), file.target);
      assert.equal(file.target, `~/${posix.normalize(file.target.slice(2))}`, file.target);
      assert.ok(
        item.name === "app" || !protectedFiles.has(file.target),
        `${item.name}: protected app file ${file.target}`,
      );
      assert.ok(
        !owners.has(file.target),
        `${item.name}: ${file.target} is already owned by ${owners.get(file.target)}`,
      );
      owners.set(file.target, item.name);
    }
  }
}

/** Release specs replace workspace and catalog names; local packs never enter a normal build. */
async function releasePackage(path, packs, releaseVersion) {
  const pkg = JSON.parse(await readFile(path, "utf8"));
  const workspace = await readFile(join(root, "pnpm-workspace.yaml"), "utf8");
  const catalog = Object.fromEntries(
    [
      ...workspace
        .split("catalog:\n")
        .at(1)
        .split("\noverrides:")
        .at(0)
        .matchAll(/^  "?([^":]+)"?: (.+)$/gm),
    ].map(([, name, version]) => [name, version.replaceAll('"', "")]),
  );
  for (const dependencies of [pkg.dependencies, pkg.devDependencies]) {
    for (const [name, version] of Object.entries(dependencies)) {
      if (version.startsWith("npm:") && !version.slice(4).includes("@"))
        dependencies[name] = version.slice(4);
      if (version === "catalog:") dependencies[name] = catalog[name];
      if (version === "workspace:*") {
        const release = JSON.parse(
          await readFile(join(root, "packages", name.split("/").at(1), "package.json"), "utf8"),
        );
        dependencies[name] = packs
          ? `file:${join(resolve(packs), `${name.slice(1).replace("/", "-")}-${release.version}.tgz`)}`
          : releaseUrls(releaseVersion)[name];
      }
      assert.ok(dependencies[name], name);
      assert.ok(!dependencies[name].endsWith(":"), name);
    }
  }
  pkg.overrides = { vite: "$vite" };
  return pkg;
}

/** One release tag pins packages and registry links unless a local proof supplies paths. */
async function registryRelease({ packs, url, version }) {
  version ??= JSON.parse(await readFile(join(root, "packages/start/package.json"), "utf8")).version;
  url ??= `https://raw.githubusercontent.com/lagz0ne/tinkered/start-v${version}/apps/start-scaffold/public/r`;
  return { packs, url, version };
}

/** Example package specs use the same release versions as the source app. */
function itemDependencies(item, full) {
  return Object.fromEntries(
    ["dependencies", "devDependencies"]
      .filter((field) => item[field])
      .map((field) => [
        field,
        item[field].map((dependency) => {
          const name = dependency.slice(0, dependency.lastIndexOf("@"));
          return `${name}@${full.dependencies[name] ?? full.devDependencies[name]}`;
        }),
      ]),
  );
}

/** A copied receipt lets doctor read the item's requirements without a registry connection. */
function receipt(item) {
  if (!item.meta.parts) return [];
  return [
    {
      path: `src/examples/${item.name}.tinker.json`,
      target: `~/src/examples/${item.name}.tinker.json`,
      type: "registry:file",
      content:
        JSON.stringify(
          { name: item.name, parts: item.meta.parts, seams: item.meta.seams },
          null,
          2,
        ) + "\n",
    },
  ];
}

/** Copied tests refer to the consumer's files, whatever name their package has. */
async function fileContent(file, packages) {
  if (packages[file.path]) return JSON.stringify(packages[file.path], null, 2) + "\n";
  const text = await readFile(join(app, file.path), "utf8");
  if (!file.path.startsWith("tests/")) return text;
  return text
    .replaceAll('"@tinker-start-scaffold/backend"', '"../src/backend/index"')
    .replaceAll('"@tinker-start-scaffold/frontend"', '"../src/frontend/index"')
    .replaceAll('"@tinker-start-scaffold/testing"', '"./presets"');
}

/** Each item reads the app's source; targets keep shadcn inside the consumer's folder. */
export async function registryItems(options = {}) {
  const { packs, url, version } = await registryRelease(options);
  const registry =
    options.registry ?? JSON.parse(await readFile(join(app, "registry.json"), "utf8"));
  checkTargets(registry);
  const full = await releasePackage(join(app, "package.json"), packs, version);
  const minimal = await releasePackage(join(root, "apps/start-min/package.json"), packs, version);
  minimal.name = "tinker-app";
  const tasks = Object.keys(full.scripts).filter(
    (name) => name.startsWith("test:") && name !== "test:schema",
  );
  for (const name of ["registry:build", ...tasks]) delete full.scripts[name];
  full.scripts.check =
    "vp check && vp run typecheck && vp run test && vp run check:plain && vp run test:schema && vp run doctor";
  const packages = { "app.package.json": minimal, "starter.package.json": full };
  const items = [];
  for (const item of registry.items) {
    const emitted = { $schema: "https://ui.shadcn.com/schema/registry-item.json", ...item };
    Object.assign(emitted, itemDependencies(item, full));
    if (item.registryDependencies)
      emitted.registryDependencies = item.registryDependencies.map(
        (name) => `${url.replace(/\/$/, "")}/${name.replace("@tinker-start/", "")}.json`,
      );
    emitted.files = await Promise.all(
      item.files.map(async (file) => ({
        ...file,
        content: await fileContent(file, packages),
      })),
    );
    emitted.files.push(...receipt(item));
    items.push(emitted);
  }
  return { registry, items, packages };
}
