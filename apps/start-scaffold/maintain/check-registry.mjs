import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { checkServe } from "./check-serve.mjs";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(app, "registry.json"), "utf8"));
const fixed = manifest.items.find((item) => item.name === "runtime");
assert.ok(fixed);
assert.equal(fixed.registryDependencies, undefined);
assert.ok(fixed.files.every((file) => file.path.startsWith("src/scaffold/")));
const payloads = new Map();
for (const item of manifest.items) {
  const payload = await readFile(join(app, "public/r", `${item.name}.json`), "utf8");
  const built = JSON.parse(payload);
  for (const file of item.files) {
    const emitted = built.files.find((entry) => entry.path === file.path);
    assert.ok(emitted, file.path);
    assert.equal(emitted.target, file.target);
    assert.equal(emitted.content, await readFile(join(app, file.path), "utf8"));
  }
  payloads.set(`/r/${item.name}.json`, payload);
}
const server = createServer((request, response) => {
  const payload = payloads.get(request.url);
  response.writeHead(payload ? 200 : 404, { "content-type": "application/json" });
  response.end(payload ?? "{}");
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert.ok(address && typeof address !== "string");
const consumer = await mkdtemp(join(tmpdir(), "start-refine-consumer-"));
const repo = resolve(app, "../..");
const vp = join(repo, "node_modules/.bin/vp");
const gates = [];
let step = 0;
async function run(args, cwd = consumer, command = vp, name = args.join("-")) {
  const child = spawn(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: `${join(consumer, "node_modules/.bin")}:${process.env.PATH}` },
  });
  let output = "";
  child.stdout.on("data", (data) => (output += data));
  child.stderr.on("data", (data) => (output += data));
  const code = await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  });
  const log = join(
    tmpdir(),
    `start-refine-consumer-${++step}-${name.replaceAll(/[^a-z0-9-]/gi, "_")}.log`,
  );
  await writeFile(log, output + `\nEXIT ${code}\n`);
  gates.push({ name, code, log });
  console.log(`${name}: EXIT ${code}; ${log}`);
  assert.equal(code, 0, output);
  return output;
}
function consumerTarget(file) {
  return file.target.startsWith("@lib/")
    ? file.target.replace("@lib/", "src/app-lib/")
    : file.target.slice(2);
}
async function hashes(folder = consumer, prefix = "") {
  const rows = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) rows.push(...(await hashes(join(folder, entry.name), path)));
    else
      rows.push([
        path,
        createHash("sha256")
          .update(await readFile(join(folder, entry.name)))
          .digest("hex"),
      ]);
  }
  return rows.sort(([a], [b]) => a.localeCompare(b));
}
try {
  for (const name of ["core", "react"]) {
    await run(
      ["--dir", join(repo, "packages", name), "pack", "--out", join(consumer, `${name}.tgz`)],
      repo,
      "pnpm",
      `pack-${name}`,
    );
  }
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ name: "clean-start-consumer", private: true, type: "module" }),
  );
  await run(
    ["install", "./core.tgz", "./react.tgz", "react@^19.3.0"],
    consumer,
    "npm",
    "install-tarballs",
  );
  const components = JSON.parse(await readFile(join(app, "components.json"), "utf8"));
  components.aliases.lib = "@/app-lib";
  await writeFile(join(consumer, "components.json"), JSON.stringify(components, null, 2));
  await writeFile(join(consumer, "tsconfig.json"), await readFile(join(app, "tsconfig.json")));
  const cli = ["dlx", "--", "shadcn@4.21.0"];
  await run([
    ...cli,
    "registry",
    "add",
    `@tinker-start=http://127.0.0.1:${address.port}/r/{name}.json`,
  ]);
  await run([...cli, "add", "@tinker-start/starter", "--yes", "--overwrite"]);
  for (const item of manifest.items) {
    for (const file of item.files) {
      assert.equal(
        await readFile(join(consumer, consumerTarget(file)), "utf8"),
        file.type === "registry:lib"
          ? (await readFile(join(app, file.path), "utf8")).replaceAll("@/lib/", "@/app-lib/")
          : await readFile(join(app, file.path), "utf8"),
      );
    }
  }
  const seams = ["src/app-lib/tinker.ts", "src/app-lib/tinker.server.ts"];
  const imports = await readFile(join(consumer, "src/scaffold/frontend/sync.ts"), "utf8");
  assert.ok(imports.includes('from "@/app-lib/tinker"'), "shadcn must rewrite the lib seam");
  const feature = "src/backend/todos.ts";
  const edited =
    "/** My feature edit must survive setup updates. */\n" +
    (await readFile(join(consumer, feature), "utf8"));
  await writeFile(join(consumer, feature), edited);
  const setup = "src/scaffold/frontend/index.ts";
  await writeFile(
    join(consumer, setup),
    "/** Older setup version for the update proof. */\n" +
      (await readFile(join(consumer, setup), "utf8")),
  );
  for (const file of seams) {
    await writeFile(
      join(consumer, file),
      "/** My seam edit must survive setup updates. */\n" +
        (await readFile(join(consumer, file), "utf8")),
    );
  }
  const editedSeams = await Promise.all(
    seams.map((file) => readFile(join(consumer, file), "utf8")),
  );
  const before = await hashes();
  const diff = await run([...cli, "add", "@tinker-start/runtime", "--dry-run", "--diff", setup]);
  assert.ok(diff.includes("Older setup version"), diff);
  assert.deepEqual(await hashes(), before);
  await run([...cli, "add", "@tinker-start/runtime", "--yes", "--overwrite"]);
  assert.equal(await readFile(join(consumer, feature), "utf8"), edited);
  for (const file of fixed.files) {
    assert.equal(
      await readFile(join(consumer, consumerTarget(file)), "utf8"),
      file.type === "registry:lib"
        ? (await readFile(join(app, file.path), "utf8")).replaceAll("@/lib/", "@/app-lib/")
        : await readFile(join(app, file.path), "utf8"),
    );
  }
  assert.deepEqual(
    await Promise.all(seams.map((file) => readFile(join(consumer, file), "utf8"))),
    editedSeams,
  );
  await run(["install"], consumer, "npm", "install-starter");
  const installed = join(consumer, "node_modules/.bin/vp");
  for (const name of ["core", "react"]) {
    assert.ok((await realpath(join(consumer, "node_modules/@tinker", name))).startsWith(consumer));
    const lock = JSON.parse(await readFile(join(consumer, "package-lock.json"), "utf8"));
    assert.equal(lock.packages[`node_modules/@tinker/${name}`].resolved, `file:${name}.tgz`);
  }
  for (const task of [
    "build",
    "typecheck",
    "test",
    "check:plain",
    "test:seam",
    "test:boundary",
    "test:schema",
  ]) {
    await run(["run", task], consumer, installed, task);
  }
  const copied = await hashes();
  await checkServe(consumer);
  assert.ok(!copied.some(([path]) => path.startsWith("maintain/") || path === "src/proof.ts"));
  for (const item of manifest.items) {
    for (const file of item.files) {
      assert.ok(
        !(await readFile(join(consumer, consumerTarget(file)), "utf8")).includes(
          "START_PROOF_MODE",
        ),
        file.path,
      );
    }
  }
  for (const name of [
    "tinker-forms",
    "tinker-seams",
    "tinker-feature",
    "tinker-sync",
    "tinker-testing",
  ]) {
    assert.ok(await readFile(join(consumer, ".agents/skills", name, "SKILL.md"), "utf8"));
  }
  assert.ok(await readFile(join(consumer, "AGENTS.md"), "utf8"));
  const proof = {
    cli: "shadcn@4.21.0",
    items: manifest.items.length,
    files: manifest.items.reduce((count, item) => count + item.files.length, 0),
    payloads: "exact source",
    install: "source with lib alias rewritten to @/app-lib",
    aliasRewrite: "seam imports rewritten",
    seamUpdate: "both edited seam files unchanged",
    dryRun: "unchanged",
    setupUpdate: "passed",
    editedFeature: "unchanged",
    consumerBuild: "passed",
    consumerNativeResponse: "status 200; body { ok: true }",
    consumerTypes: "passed",
    dependencies: "Core and React packed tarballs; independent npm install; no workspace links",
    projectTests: "passed",
    projectGates: "plain, seam, browser imports, schema passed",
    skills: "all five, plus AGENTS.md",
    maintainerFiles: "none",
    proofMode: "none",
    gates,
  };
  await writeFile(
    join(tmpdir(), "start-refine-consumer-proof.json"),
    JSON.stringify(proof, null, 2) + "\n",
  );
  console.log(JSON.stringify(proof));
} finally {
  await new Promise((done) => server.close(done));
  await rm(consumer, { recursive: true, force: true });
}
