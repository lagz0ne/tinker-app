import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { app, root } from "./registry-source.mjs";
import { copyTemplates } from "./template-sync.mjs";

/** Both template copies must build from the same committed runtime source. */
const scratch = await mkdtemp(join(tmpdir(), "start-templates-"));

try {
  await copyTemplates(scratch);
  const minimal = join(root, "apps/start-min/tinker");
  await compareFiles(join(minimal, "base"), join(app, "tinker/base"));
  for (const name of await readdir(join(minimal, "components"))) {
    await compareFiles(join(minimal, "components", name), join(app, "tinker/components", name));
  }
  for (const name of ["small", "demo"]) {
    const source = name === "small" ? join(root, "apps/start-min") : app;
    const target = join(scratch, name);
    for (const path of ["src", "cmds", "tinker"]) {
      await compareFiles(join(source, path), join(target, path));
    }

    const pkg = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
    assert.ok(pkg.devDependencies["@tinker/start"]);
    assert.equal(pkg.dependencies["@tinker/start"], undefined);
    assert.ok(!/workspace:|catalog:/.test(JSON.stringify(pkg)));

    await symlink(join(app, "node_modules"), join(target, "node_modules"), "dir");
    const build = spawnSync("vp", ["build"], { cwd: target, encoding: "utf8", timeout: 120000 });
    assert.equal(build.status, 0, build.stdout + build.stderr);
    console.log(`PASS: ${name} copied source matches; build EXIT 0.`);
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

async function compareFiles(source, target) {
  assert.deepEqual(
    (await readdir(target)).sort(),
    (await readdir(source)).sort(),
    `copy inventory differs: ${source}`,
  );
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isDirectory()) await compareFiles(join(source, entry.name), join(target, entry.name));
    else {
      assert.deepEqual(
        await readFile(join(target, entry.name)),
        await readFile(join(source, entry.name)),
        `copy differs: ${source}/${entry.name}`,
      );
    }
  }
}
