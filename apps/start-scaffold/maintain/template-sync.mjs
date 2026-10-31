import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { entryOf, writeLock } from "../../../packages/start/lib/lock.mjs";
import { listFiles } from "../../../packages/start/lib/paths.mjs";
import { app, root, registryItems, templateHostVersion } from "./registry-source.mjs";

/** Copy the actual source into an empty output folder; never edit a template checkout. */
export async function copyTemplates(out, { packs } = {}) {
  const current = JSON.parse(await readFile(join(root, "packages/start/package.json"), "utf8"));
  assert.ok(
    packs || current.version.localeCompare(templateHostVersion, undefined, { numeric: true }) >= 0,
    `Export blocked: these templates require @tinker/start ${templateHostVersion} and its matching registry. The released 0.9.0 host is incompatible. Plan that release first; nothing was published. Local proofs must supply an explicit current host pack.`,
  );

  await mkdir(out, { recursive: true });
  assert.deepEqual(await readdir(out), [], "template output must be empty");
  const { items, packages } = await registryItems({ packs });

  if (packs) {
    const host = packages["app.package.json"].devDependencies["@tinker/start"].slice(5);
    await checkHostPack(host);
  }

  for (const [name, source, pkg] of [
    ["small", join(root, "apps/start-min"), packages["app.package.json"]],
    ["demo", app, packages["starter.package.json"]],
  ]) {
    const target = join(out, name);
    await mkdir(target);
    if (packs) {
      const host = pkg.devDependencies["@tinker/start"].slice("file:".length);
      await mkdir(join(target, "vendor"));
      await cp(host, join(target, "vendor", basename(host)));
      pkg.devDependencies["@tinker/start"] = `file:./vendor/${basename(host)}`;
    }
    for (const path of ["src", "cmds", "tinker", "tsconfig.json", "vite.config.ts"]) {
      await cp(join(source, path), join(target, path), { recursive: true });
    }
    if (name === "demo") await copyDemoFiles(target);
    else {
      await cp(join(source, "README.md"), join(target, "README.md"));
      await cp(join(source, ".env.example"), join(target, ".env.example"));
    }

    await cp(join(app, "templates/gitignore"), join(target, ".gitignore"));
    await writeFile(join(target, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
    await writeTemplateLock(target, items, templateHostVersion);
    console.log(`Copied ${name}: ${target}`);
  }
}

/**
 * Write `tinker/components.lock` for every component folder the export holds, from its bytes.
 * @param {string} target - From copyTemplates; why: the exported app.
 * @param {object[]} items - From registryItems; why: the items that list outside files.
 * @param {string} start - From copyTemplates; why: the Start version the export pins.
 */
async function writeTemplateLock(target, items, start) {
  const components = {};
  for (const entry of await readdir(join(target, "tinker/components"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const paths = await componentPaths(target, entry.name, items);
    components[entry.name] = await entryOf(target, paths, start);
  }
  await writeLock(target, { components, version: 1 });
}

/**
 * The paths one exported component owns: its folder files, plus registry outside files it holds.
 * @param {string} target - From writeTemplateLock; why: the exported app.
 * @param {string} name - From writeTemplateLock; why: the component folder.
 * @param {object[]} items - From registryItems; why: the registry's items.
 */
async function componentPaths(target, name, items) {
  const prefix = `tinker/components/${name}`;
  const folder = join(target, prefix);
  const inside = listFiles(folder, folder).map((file) => `${prefix}/${file}`);
  const item = items.find((entry) => entry.name === name);

  const outside = (item?.files ?? [])
    .map((file) => file.target.replace(/^~\//, ""))
    .filter((path) => !path.startsWith(`${prefix}/`) && existsSync(join(target, path)));
  return [...inside, ...outside];
}

/** Check the native host files before allowing an explicit local proof pack. */
async function checkHostPack(host) {
  for (const file of ["lib/main-host.mjs", "lib/command-gate.mjs"]) {
    let content;
    try {
      content = execFileSync("tar", ["-xOf", host, `package/${file}`], { encoding: "utf8" });
    } catch (error) {
      throw new Error(
        `Local host pack is incompatible; templates require Start ${templateHostVersion} or a pack of the current source.`,
        { cause: error },
      );
    }
    assert.equal(
      content,
      await readFile(join(root, "packages/start", file), "utf8"),
      `Local host pack must match the current source; templates require Start ${templateHostVersion}.`,
    );
  }
}

async function copyDemoFiles(target) {
  for (const path of [
    "tests",
    "maintain/proof-server-close.mjs",
    "maintain/proof-exit-controls.mjs",
    "maintain/proof-bootstrap-controls.mjs",
    "maintain/proof-migration-contract.mjs",
    "maintain/proof-migration-contract-controls.mjs",
    "maintain/proof-fault.mjs",
    "scripts/check-plain.mjs",
    "scripts/check-schema.mjs",
    "scripts/setup.mjs",
    "drizzle",
    "drizzle.config.ts",
    // The SQLite variant's schema and Reylo's dev database: the build's type check reads them.
    "sqlite",
    ".reylo.yaml",
    "compose.yml",
    ".env.example",
    "AGENTS.md",
    "README.md",
    ".agents",
    "vitest.config.ts",
    "vite.worker.config.ts",
    "maintain/worker.mjs",
    "maintain/sqlite-dev-db.mjs",
    "stryker.config.json",
    "scripts/mutation-arid.mjs",
  ]) {
    await mkdir(dirname(join(target, path)), { recursive: true });
    await cp(join(app, path), join(target, path), { recursive: true });
  }
}

if (import.meta.main) {
  assert.ok(process.argv[2], "usage: node maintain/template-sync.mjs /tmp/tinker-app-export");
  await copyTemplates(resolve(process.argv[2]));
}
