import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, posix, resolve } from "node:path";

import { releaseUrls } from "../../../packages/start/lib/release.mjs";

export const app = resolve(import.meta.dirname, "..");
export const root = resolve(app, "../..");

/** The new main/host contract first ships together in this planned release. */
export const templateHostVersion = "0.10.0";

/** Examples may add files, but never replace the app template or another item's files. */
function checkTargets(registry) {
  const protectedFiles = new Set([
    ...registry.items.find((item) => item.name === "app").files.map((file) => file.target),
    "~/package.json",
    "~/vite.config.ts",
    "~/vite.config.mts",
    "~/tsconfig.json",
    "~/cmds/start.ts",
    "~/cmds/router.ts",
    "~/cmds/server.ts",
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

/** All copied runtime files come from the golden app, with one item per owner. */
async function checkCopiedItems(registry) {
  const folders = await readdir(join(app, "tinker/components"), { withFileTypes: true });
  for (const folder of folders.filter((entry) => entry.isDirectory())) {
    const prefix = `tinker/components/${folder.name}`;
    const manifest = JSON.parse(await readFile(join(app, prefix, "component.json"), "utf8"));
    await checkCopiedItem(registry, folder.name, prefix, manifest.requires);
  }

  await checkCopiedItem(registry, "base", "tinker/base", ["errors", "requests"]);
  const business = await copiedFiles("src/demo");
  const requires = new Set();
  for (const file of business) {
    const source = await readFile(join(app, file), "utf8");
    for (const match of source.matchAll(/from\s+["']~\/components\/([^/"']+)/g)) {
      requires.add(match[1]);
    }
  }
  await checkCopiedItem(registry, "demo", "src/demo", [...requires]);
}

/** Dependencies are direct requires, and source paths cover that owner exactly. */
async function checkCopiedItem(registry, name, prefix, requires) {
  const item = registry.items.find((entry) => entry.name === name);
  assert.ok(item, `missing copied item ${name}`);
  assert.deepEqual(
    [...(item.registryDependencies ?? [])].sort((a, b) => a.localeCompare(b)),
    requires.map((entry) => `@tinker-start/${entry}`).sort((a, b) => a.localeCompare(b)),
    `${name}: registryDependencies must equal requires`,
  );

  const files = item.files.filter((file) => file.target.startsWith(`~/${prefix}/`));
  assert.deepEqual(
    files.map((file) => file.path).sort(),
    (await copiedFiles(prefix)).sort(),
    `${name}: files must cover its golden source`,
  );
  for (const file of files) {
    assert.equal(file.target, `~/${file.path}`, `${name}: copied source target`);
    assert.equal(file.type, "registry:file", `${name}: explicit file target`);
  }
}

async function copiedFiles(prefix) {
  const entries = await readdir(join(app, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await copiedFiles(path)));
    else files.push(path);
  }
  return files;
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
      if (version.startsWith("npm:") && !version.slice(4).includes("@")) {
        dependencies[name] = version.slice(4);
      }
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

  // npm 10 cannot resolve a "$vite" reference to an alias spec, so name the spec itself.
  pkg.overrides = { vite: pkg.devDependencies.vite };
  return pkg;
}

/** One release tag pins packages and registry links unless a local proof supplies paths. */
async function registryRelease({ packs, url, version }) {
  version ??= templateHostVersion;
  releaseUrls(version);
  assert.ok(
    packs || version.localeCompare(templateHostVersion, undefined, { numeric: true }) >= 0,
    `These templates require @tinker/start ${templateHostVersion}; the released 0.9.0 host is incompatible. Publish a matching Start and registry release first, or use an explicit current local pack for proofs.`,
  );
  url ??= `https://raw.githubusercontent.com/lagz0ne/tinker-app/start-v${version}/apps/start-scaffold/public/r`;
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
          const name = dependency.match(/^(@[^/]+\/[^@]+|[^@]+)/)[0];
          return `${name}@${full.dependencies[name] ?? full.devDependencies[name]}`;
        }),
      ]),
  );
}

/** Package files come from their template; tests are copied as they are. */
async function fileContent(file, packages) {
  if (packages[file.path]) return JSON.stringify(packages[file.path], null, 2) + "\n";

  const text = await readFile(join(app, file.path), "utf8");
  return text;
}

/** Each item reads the app's source; targets keep shadcn inside the consumer's folder. */
export async function registryItems(options = {}) {
  const { packs, url, version } = await registryRelease(options);
  const registry =
    options.registry ?? JSON.parse(await readFile(join(app, "registry.json"), "utf8"));
  checkTargets(registry);
  await checkCopiedItems(registry);

  const full = await releasePackage(join(app, "package.json"), packs, version);
  const minimal = await releasePackage(join(root, "apps/start-min/package.json"), packs, version);
  minimal.name = "tinker-app";

  const tasks = Object.keys(full.scripts).filter(
    (name) => name.startsWith("test:") && !["test:schema", "test:proofs"].includes(name),
  );
  for (const name of ["registry:build", "check:commands", ...tasks]) delete full.scripts[name];
  full.scripts.check =
    "vp run gate:commands && vp check && vp run typecheck && vp run test && vp run test:proofs && vp run check:plain && vp run test:schema && vp run doctor";

  const packages = { "app.package.json": minimal, "starter.package.json": full };
  const items = [];

  for (const item of registry.items) {
    const emitted = { $schema: "https://ui.shadcn.com/schema/registry-component.json", ...item };
    Object.assign(emitted, itemDependencies(item, full));

    if (item.registryDependencies) {
      emitted.registryDependencies = item.registryDependencies.map(
        (name) => `${url.replace(/\/$/, "")}/${name.replace("@tinker-start/", "")}.json`,
      );
    }

    emitted.files = await Promise.all(
      item.files.map(async (file) => ({
        ...file,
        content: await fileContent(file, packages),
      })),
    );

    items.push(emitted);
  }

  return { registry, items, packages };
}
