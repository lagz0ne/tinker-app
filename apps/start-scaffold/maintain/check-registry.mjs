import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { app, registryItems } from "./registry-source.mjs";

/** Match every built item to source, then build the two supported compositions. */
const { registry, items } = await registryItems();
assert.equal(new Set(items.map((item) => item.name)).size, items.length);
const names = new Set(items.map((item) => item.name));
assert.deepEqual(items.find((item) => item.name === "runtime").files, []);
assert.deepEqual(
  JSON.parse(await readFile(join(app, "public/r/registry.json"), "utf8")),
  { ...registry, items },
  "registry index must match source too",
);
let files = 0;
for (const item of items) {
  const built = JSON.parse(await readFile(join(app, "public/r", `${item.name}.json`), "utf8"));
  assert.deepEqual(built, item, `${item.name}: rebuild registry:build after changing source`);
  for (const dependency of registry.items.find((entry) => entry.name === item.name)
    .registryDependencies ?? [])
    assert.ok(names.has(dependency.replace("@tinker-start/", "")), dependency);
  assert.equal(new Set(item.files.map((file) => file.target)).size, item.files.length, item.name);
  for (const file of item.files) {
    assert.ok(file.target.startsWith("~/"), file.target);
    assert.ok(!file.target.includes("/../"), file.target);
    assert.ok(!/\/src\/scaffold\/|\/node_modules\/|\/\.tinker\//.test(file.target), file.target);
    files++;
  }
}
for (const composition of [["app"], ["postgres-auth-mail-example", "starter"]]) {
  const consumer = await mkdtemp(join(tmpdir(), "start-registry-consumer-"));
  try {
    for (const name of composition) {
      for (const file of items.find((item) => item.name === name).files) {
        const target = join(consumer, file.target.slice(2));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.content);
      }
    }
    const installed = JSON.parse(await readFile(join(consumer, "package.json"), "utf8"));
    assert.match(
      installed.dependencies["@tinker/start"],
      /releases\/download\/start-v0\.7\.0\/tinker-start-0\.7\.0\.tgz$/,
    );
    assert.ok(!/workspace:|catalog:/.test(JSON.stringify(installed)));
    await symlink(join(app, "node_modules"), join(consumer, "node_modules"), "dir");
    const build = spawnSync("vp", ["build"], { cwd: consumer, encoding: "utf8", timeout: 120000 });
    assert.equal(build.status, 0, build.stdout + build.stderr);
    if (composition.includes("starter")) {
      for (const task of Object.values(installed.scripts)) {
        const path = task.match(/^node (scripts\/\S+)/)?.[1];
        if (path) await readFile(join(consumer, path));
      }
      const plain = spawnSync(process.execPath, ["scripts/check-plain.mjs"], {
        cwd: consumer,
        encoding: "utf8",
      });
      assert.equal(plain.status, 0, plain.stdout + plain.stderr);
    }
    console.log(`PASS: ${composition.join(" + ")} composition build EXIT 0.`);
  } finally {
    await rm(consumer, { recursive: true, force: true });
  }
}
console.log(
  `PASS: ${items.length} registry items; ${files} emitted files match source. No publish.`,
);
