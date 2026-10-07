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
for (const target of new Set([
  ...registry.items.find((item) => item.name === "app").files.map((file) => file.target),
  "~/package.json",
  "~/vite.config.ts",
  "~/vite.config.mts",
  "~/tsconfig.json",
  "~/src/lib/tinker.ts",
  "~/src/lib/tinker.server.ts",
])) {
  const planted = structuredClone(registry);
  planted.items
    .find((item) => item.name === "mail-example")
    .files.push({
      path: "unused",
      type: "registry:file",
      target,
    });
  await assert.rejects(registryItems({ registry: planted }), /protected app file/);
  console.log(`PASS: registry build rejects protected target ${target}.`);
}
const duplicate = structuredClone(registry);
duplicate.items
  .find((item) => item.name === "todos-example")
  .files.push({
    path: "src/errors.ts",
    type: "registry:file",
    target: "~/src/errors.ts",
  });
await assert.rejects(registryItems({ registry: duplicate }), /already owned/);
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
for (const composition of [["app"], ["app", "starter"]]) {
  const consumer = await mkdtemp(join(tmpdir(), "start-registry-consumer-"));
  try {
    const copied = new Set();
    async function copyItem(name) {
      if (copied.has(name)) return;
      copied.add(name);
      const item = items.find((item) => item.name === name);
      for (const dependency of item.registryDependencies ?? [])
        await copyItem(dependency.split("/").at(-1).replace(".json", ""));
      for (const file of item.files) {
        const target = join(consumer, file.target.slice(2));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.content);
      }
    }
    for (const name of composition) await copyItem(name);
    const installed = JSON.parse(await readFile(join(consumer, "package.json"), "utf8"));
    const template = JSON.parse(
      items
        .find((item) => item.name === "app")
        .files.find((file) => file.target === "~/package.json").content,
    );
    assert.equal(installed.dependencies["@tinker/start"], template.dependencies["@tinker/start"]);
    assert.ok(!/workspace:|catalog:/.test(JSON.stringify(installed)));
    await symlink(join(app, "node_modules"), join(consumer, "node_modules"), "dir");
    if (composition.includes("starter")) {
      await writeFile(
        join(consumer, "vite.config.ts"),
        await readFile(join(app, "vite.config.ts")),
      );
      for (const seam of ["tinker.ts", "tinker.server.ts"])
        await writeFile(
          join(consumer, "src/lib", seam),
          await readFile(join(app, "src/lib", seam)),
        );
    }
    const build = spawnSync("vp", ["build"], { cwd: consumer, encoding: "utf8", timeout: 120000 });
    assert.equal(build.status, 0, build.stdout + build.stderr);
    if (composition.includes("starter")) {
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
