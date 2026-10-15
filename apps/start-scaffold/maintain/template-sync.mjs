import assert from "node:assert/strict";
import { cp, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { app, root, registryItems } from "./registry-source.mjs";

/** Copy the actual source into an empty output folder; never edit a template checkout. */
export async function copyTemplates(out) {
  await mkdir(out, { recursive: true });
  assert.deepEqual(await readdir(out), [], "template output must be empty");
  const { packages } = await registryItems();
  for (const [name, source, pkg] of [
    ["small", join(root, "apps/start-min"), packages["app.package.json"]],
    ["demo", app, packages["starter.package.json"]],
  ]) {
    const target = join(out, name);
    await mkdir(target);
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
    console.log(`Copied ${name}: ${target}`);
  }
}

async function copyDemoFiles(target) {
  for (const path of [
    "tests",
    "scripts/check-plain.mjs",
    "scripts/check-schema.mjs",
    "scripts/setup.mjs",
    "drizzle",
    "drizzle.config.ts",
    "compose.yml",
    ".env.example",
    "AGENTS.md",
    "PLAIN.md",
    "README.md",
    ".agents",
    "vitest.config.ts",
    "stryker.config.json",
  ]) {
    await mkdir(dirname(join(target, path)), { recursive: true });
    await cp(join(app, path), join(target, path), { recursive: true });
  }
}

if (import.meta.main) {
  assert.ok(process.argv[2], "usage: node maintain/template-sync.mjs /tmp/tinker-app-export");
  await copyTemplates(resolve(process.argv[2]));
}
