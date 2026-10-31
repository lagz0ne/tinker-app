import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { PGlite } from "@electric-sql/pglite";

import { checkRegistryIndex } from "./check-registry-index.mjs";
import { app, registryItems } from "./registry-source.mjs";

/** Match every built item to source, then build the two supported compositions. */
const { registry, items, files } = await checkRegistryIndex();

for (const migration of ["20261018041738_durable_mail", "20261019093400_mail_exhausted"]) {
  const missing = structuredClone(registry);
  const example = missing.items.find((item) => item.name === "mail");
  example.files = example.files.filter((file) => !file.path.includes(migration));
  await assert.rejects(registryItems({ registry: missing }), /mail component must ship/);
  console.log(`PASS: mail component rejects missing ${migration}.`);
}

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

const otherScript = structuredClone(registry);

otherScript.items
  .find((item) => item.name === "database-sqlite")
  .files.push({
    path: "maintain/worker.mjs",
    type: "registry:file",
    target: "~/maintain/proof-fault.mjs",
  });

await assert.rejects(registryItems({ registry: otherScript }), /already owned/);
console.log("PASS: a maintain/ target two items share must be the same source file.");

for (const name of [
  "errors",
  "requests",
  "health",
  "http",
  "mcp",
  "database",
  "auth",
  "telemetry",
  "sync",
  "mail",
  "agent-talk",
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

for (const composition of [
  ["app"],
  ["app", "mail-example"],
  ["app", "postgres-auth-mail-example"],
  ["app", "starter"],
]) {
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

    if (composition.includes("starter") || composition.includes("postgres-auth-mail-example")) {
      const config = await readFile(join(app, "vite.config.ts"), "utf8");
      await writeFile(
        join(consumer, "vite.config.ts"),
        composition.includes("starter")
          ? config
          : config.replace('      workerEntry: "cmds/worker.ts",\n', ""),
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

    if (
      composition.includes("mail-example") ||
      composition.includes("postgres-auth-mail-example")
    ) {
      const client = await PGlite.create();

      try {
        const migrations = await readdir(join(consumer, "drizzle")).catch((error) => {
          assert.equal(error.code, "ENOENT");
          return [];
        });
        for (const migration of migrations.sort((left, right) => left.localeCompare(right))) {
          await client.exec(
            await readFile(join(consumer, "drizzle", migration, "migration.sql"), "utf8"),
          );
        }
        const result = await client.query(
          `INSERT INTO mail_outbox ("to", subject, text, dedupe_key)
           VALUES ('receiver@example.test', 'Exported mail', 'Body', 'registry-proof') RETURNING id`,
        );
        assert.equal(result.rows.length, 1, "standalone mail example must durably enqueue");
      } finally {
        await client.close();
      }
      console.log(
        `PASS: ${composition.join(" + ")} migrates and durably enqueues without starter.`,
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
