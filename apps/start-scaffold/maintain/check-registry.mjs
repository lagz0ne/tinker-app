import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { checkRegistryIndex } from "./check-registry-index.mjs";
import { app, registryItems } from "./registry-source.mjs";

/** Match every built item to source, then build the two supported compositions. */
const { registry, items, files } = await checkRegistryIndex();

for (const target of new Set([
  ...registry.items.find((item) => item.name === "app").files.map((file) => file.target),
  "~/package.json",
  "~/vite.config.ts",
  "~/vite.config.mts",
  "~/tsconfig.json",
  "~/cmds/start.ts",
  "~/cmds/router.ts",
  "~/cmds/server.ts",
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
    path: "src/demo/errors.ts",
    type: "registry:file",
    target: "~/src/demo/errors.ts",
  });

await assert.rejects(registryItems({ registry: duplicate }), /already owned/);

for (const name of [
  "errors",
  "requests",
  "health",
  "http",
  "database",
  "auth",
  "telemetry",
  "sync",
  "mail",
  "demo",
  "base",
]) {
  const wrong = structuredClone(registry);
  wrong.items.find((item) => item.name === name).registryDependencies.push("@tinker-start/extra");
  await assert.rejects(
    registryItems({ registry: wrong }),
    /registryDependencies must equal requires/,
  );

  const missing = structuredClone(registry);
  missing.items.find((item) => item.name === name).files.shift();
  await assert.rejects(registryItems({ registry: missing }), /files must cover its golden source/);
}

for (const composition of [["app"], ["app", "mail-example"], ["app", "starter"]]) {
  const consumer = await mkdtemp(join(tmpdir(), "start-registry-consumer-"));
  try {
    const copied = new Set();
    async function copyItem(name) {
      if (copied.has(name)) return;
      copied.add(name);
      const item = items.find((item) => item.name === name);
      for (const dependency of item.registryDependencies ?? []) {
        await copyItem(dependency.split("/").at(-1).replace(".json", ""));
      }
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
    assert.ok(installed.devDependencies["@tinker/start"]);
    assert.equal(
      installed.devDependencies["@tinker/start"],
      template.devDependencies["@tinker/start"],
    );
    assert.equal(installed.dependencies["@tinker/start"], undefined);
    assert.ok(!/workspace:|catalog:/.test(JSON.stringify(installed)));

    await symlink(join(app, "node_modules"), join(consumer, "node_modules"), "dir");

    if (composition.includes("starter")) {
      await writeFile(
        join(consumer, "vite.config.ts"),
        await readFile(join(app, "vite.config.ts")),
      );
      await mkdir(join(consumer, "cmds"), { recursive: true });
      for (const entry of ["server.ts", "router.ts"]) {
        await writeFile(join(consumer, "cmds", entry), await readFile(join(app, "cmds", entry)));
      }
      // The user copies the demo shell/style shape beside their command wiring.
      for (const [example, target] of [
        ["demo-root.tsx", "src/routes/__root.tsx"],
        ["demo-style.css", "src/style.css"],
      ]) {
        await writeFile(
          join(consumer, target),
          await readFile(join(consumer, "examples", example)),
        );
      }
    }

    const build = spawnSync("vp", ["build"], { cwd: consumer, encoding: "utf8", timeout: 120000 });
    assert.equal(build.status, 0, build.stdout + build.stderr);

    if (composition.includes("starter")) {
      // This composition retains app's greet route beside the starter's routes.
      // Its reviewed list has exactly that one extra readResult caller.
      const saved = await readFile(join(app, "PLAIN.md"), "utf8");
      const lastRouteCaller = "    - `src/routes/api.telemetry.ts#Route.POST`\n";
      assert.equal(saved.split(lastRouteCaller).length, 2);
      const expected = saved.replace(
        lastRouteCaller,
        lastRouteCaller + "    - `src/transport/greet.functions.ts#runGreet.callback`\n",
      );
      const census = spawnSync(process.execPath, ["scripts/check-plain.mjs", "--list"], {
        cwd: consumer,
        encoding: "utf8",
      });
      assert.equal(census.status, 0, census.stdout + census.stderr);
      assert.equal(census.stdout, expected, "composition has only its known extra caller");
      await writeFile(join(consumer, "PLAIN.md"), expected);

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
