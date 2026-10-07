import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const app = resolve(import.meta.dirname, "..");
export const root = resolve(app, "../..");

/** Release specs replace workspace and catalog names; local packs never enter a normal build. */
async function releasePackage(path, packs) {
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
          : release.version;
      }
      assert.ok(dependencies[name], name);
      assert.ok(!dependencies[name].endsWith(":"), name);
    }
  }
  pkg.overrides = { vite: "$vite" };
  return pkg;
}

/** Each item reads the app's source; targets keep shadcn inside the consumer's folder. */
export async function registryItems({ packs, url = "http://127.0.0.1:4870/r" } = {}) {
  const registry = JSON.parse(await readFile(join(app, "registry.json"), "utf8"));
  const full = await releasePackage(join(app, "package.json"), packs);
  const minimal = await releasePackage(join(root, "apps/start-min/package.json"), packs);
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
    for (const field of ["dependencies", "devDependencies"]) {
      if (item[field])
        emitted[field] = item[field].map((dependency) => {
          const split = dependency.lastIndexOf("@");
          const name = dependency.slice(0, split);
          return `${name}@${full.dependencies[name] ?? full.devDependencies[name]}`;
        });
    }
    if (item.registryDependencies)
      emitted.registryDependencies = item.registryDependencies.map(
        (name) => `${url.replace(/\/$/, "")}/${name.replace("@tinker-start/", "")}.json`,
      );
    emitted.files = await Promise.all(
      item.files.map(async (file) => ({
        ...file,
        content: packages[file.path]
          ? JSON.stringify(packages[file.path], null, 2) + "\n"
          : await readFile(join(app, file.path), "utf8"),
      })),
    );
    items.push(emitted);
  }
  return { registry, items, packages };
}
