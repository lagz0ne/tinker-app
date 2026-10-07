import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Check emitted copy-in files and build their full local composition without publishing. */
const app = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(join(app, "registry.json"), "utf8"));
const runtime = manifest.items.find((item) => item.name === "runtime");
assert.deepEqual(runtime.files, []);
assert.deepEqual(runtime.dependencies, ["@tinker/start@0.6.0"]);
const names = new Set(manifest.items.map((item) => item.name));
assert.equal(names.size, manifest.items.length, "registry item names must be unique");
const consumer = await mkdtemp(join(tmpdir(), "start-registry-consumer-"));
const copied = new Set();
try {
  for (const item of manifest.items) {
    for (const name of item.registryDependencies ?? [])
      assert.ok(names.has(name.replace("@tinker-start/", "")), `missing item ${name}`);
    const built = JSON.parse(await readFile(join(app, "public/r", `${item.name}.json`), "utf8"));
    assert.deepEqual(built.dependencies, item.dependencies);
    assert.deepEqual(built.registryDependencies, item.registryDependencies);
    assert.equal(built.files.length, item.files.length);
    for (const file of item.files) {
      assert.ok(!file.path.startsWith("src/scaffold/"), file.path);
      assert.ok(!copied.has(file.target), `duplicate file owner ${file.target}`);
      copied.add(file.target);
      const emitted = built.files.find((entry) => entry.path === file.path);
      assert.ok(emitted, file.path);
      assert.equal(emitted.target, file.target);
      const content = await readFile(join(app, file.path), "utf8");
      assert.equal(emitted.content, content);
      const target = join(consumer, file.target.slice(2));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
  }
  const installed = JSON.parse(await readFile(join(consumer, "package.json"), "utf8"));
  assert.equal(installed.dependencies["@tinker/start"], "0.6.0");
  assert.ok(!JSON.stringify(installed).includes("workspace:"));
  assert.ok(!JSON.stringify(installed).includes("catalog:"));
  for (const name of ["todos-example", "profile-example", "auth-pages-example", "mail-example"])
    assert.ok(manifest.items.find((item) => item.name === name)?.files.length, name);
  for (const task of Object.values(installed.scripts)) {
    const path = task.match(/^node (scripts\/\S+)/)?.[1];
    if (path) assert.ok(copied.has(`~/${path}`), `script file missing: ${path}`);
  }
  await symlink(join(app, "node_modules"), join(consumer, "node_modules"), "dir");
  const build = spawnSync("vp", ["build"], { cwd: consumer, encoding: "utf8", timeout: 120000 });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  const plain = spawnSync(process.execPath, ["scripts/check-plain.mjs"], {
    cwd: consumer,
    encoding: "utf8",
  });
  assert.equal(plain.status, 0, plain.stdout + plain.stderr);
  console.log(
    `PASS: ${manifest.items.length} registry items; ${copied.size} files match source; composed app build and plain check EXIT 0.`,
  );
  console.log(
    "No publish or registry CLI install. The local composition uses the installed workspace dependencies.",
  );
} finally {
  await rm(consumer, { recursive: true, force: true });
}
