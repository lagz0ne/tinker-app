import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

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
  const { packages } = await registryItems({ packs });

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
    console.log(`Copied ${name}: ${target}`);
  }
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
    "maintain/proof-fault.mjs",
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
    "vite.worker.config.ts",
    "maintain/worker.mjs",
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
