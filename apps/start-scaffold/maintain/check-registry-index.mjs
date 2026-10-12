import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { app, registryItems } from "./registry-source.mjs";

/** The fast half of test:registry: each built item and the index must match source. No build runs here. */
export async function checkRegistryIndex() {
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
      .registryDependencies ?? []) {
      assert.ok(names.has(dependency.replace("@tinker-start/", "")), dependency);
    }
    assert.equal(new Set(item.files.map((file) => file.target)).size, item.files.length, item.name);
    for (const file of item.files) {
      assert.ok(file.target.startsWith("~/"), file.target);
      assert.ok(!file.target.includes("/../"), file.target);
      assert.ok(!/\/src\/scaffold\/|\/node_modules\/|\/\.tinker\//.test(file.target), file.target);
      files++;
    }
  }

  return { registry, items, files };
}

if (import.meta.main) {
  try {
    const { files } = await checkRegistryIndex();
    console.log(`PASS: registry index matches source; ${files} emitted files.`);
  } catch (error) {
    console.error(
      "Registry index check failed. Fix: pnpm --dir apps/start-scaffold run registry:build",
    );
    console.error(error.message.split("\n")[0]);
    process.exitCode = 1;
  }
}
