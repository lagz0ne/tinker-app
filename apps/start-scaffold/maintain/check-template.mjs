import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { app, root } from "./registry-source.mjs";
import { copyTemplates } from "./template-sync.mjs";

/** Both template copies must build from the same committed runtime source. */
const scratch = await mkdtemp(join(tmpdir(), "start-templates-"));

try {
  const packs = await mkdtemp(join(tmpdir(), "start-template-packs-"));
  try {
    const packed = spawnSync(
      process.execPath,
      [join(root, "packages/start/scripts/pack.mjs"), packs],
      {
        encoding: "utf8",
      },
    );
    assert.equal(packed.status, 0, packed.stdout + packed.stderr);
    await copyTemplates(scratch, { packs });
  } finally {
    await rm(packs, { recursive: true, force: true });
  }

  await checkLocks(scratch);
  const minimal = join(root, "apps/start-min/tinker");
  await compareFiles(join(minimal, "base"), join(app, "tinker/base"));
  for (const name of await readdir(join(minimal, "components"))) {
    await compareFiles(join(minimal, "components", name), join(app, "tinker/components", name));
  }
  for (const name of ["small", "demo"]) {
    const source = name === "small" ? join(root, "apps/start-min") : app;
    const target = join(scratch, name);
    for (const path of ["src", "cmds"]) {
      await compareFiles(join(source, path), join(target, path));
    }
    // Card 6b: the export adds tinker/components.lock, which records the bytes it shipped.
    await compareFiles(join(source, "tinker"), join(target, "tinker"), "components.lock");

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

async function compareFiles(source, target, extra) {
  const names = async (dir) => (await readdir(dir)).filter((name) => name !== extra).sort();
  assert.deepEqual(await names(target), await names(source), `copy inventory differs: ${source}`);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === extra) continue;
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

/**
 * Card 6b L1: each export's lock matches the bytes it wrote, and a fresh `small` checks clean.
 * @param {string} scratch - From the runner; why: the folder holding the exports.
 */
async function checkLocks(scratch) {
  for (const name of ["small", "demo"]) {
    const target = join(scratch, name);
    const lock = JSON.parse(await readFile(join(target, "tinker/components.lock"), "utf8"));
    const folders = (await readdir(join(target, "tinker/components"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    assert.equal(lock.version, 1, `${name}: lock version`);
    assert.deepEqual(Object.keys(lock.components).sort(), folders, `${name}: lock folders`);

    for (const [component, entry] of Object.entries(lock.components)) {
      const prefix = `tinker/components/${component}/`;
      const locked = Object.keys(entry.files)
        .filter((path) => path.startsWith(prefix))
        .sort();
      const onDisk = (await filesUnder(join(target, prefix)))
        .map((file) => `${prefix}${file}`)
        .sort();
      assert.deepEqual(locked, onDisk, `${name}: ${component} lock paths`);

      for (const [path, hash] of Object.entries(entry.files)) {
        const bytes = await readFile(join(target, path));
        assert.equal(
          hash,
          createHash("sha256").update(bytes).digest("hex"),
          `${name}: ${path} hash`,
        );
      }
      assert.ok(entry.start, `${name}: ${component} start version`);
    }
  }

  for (const name of ["small", "demo"]) {
    const check = spawnSync(
      process.execPath,
      [join(root, "packages/start/bin/tinker.mjs"), "check", "--registry", join(app, "public/r")],
      { cwd: join(scratch, name), encoding: "utf8" },
    );
    assert.equal(check.status, 0, `${name}: ${check.stdout}${check.stderr}`);
    assert.ok(!check.stdout.includes("no lock entry"), check.stdout);
    assert.ok(!check.stdout.includes("outdated:"), check.stdout);
  }
  console.log("PASS: both exports ship a lock that matches their files and check clean.");
}

/** Every file under `dir`, as paths relative to it. @param {string} dir - From checkLocks. */
async function filesUnder(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const file of await filesUnder(join(dir, entry.name))) {
        found.push(`${entry.name}/${file}`);
      }
    } else {
      found.push(entry.name);
    }
  }
  return found;
}
