import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join, relative } from "node:path";
import { app, root } from "./registry-source.mjs";

/** Real shadcn, packed releases, and HTTP; this proof stays outside scope tests. */
const scratch = await mkdtemp(join(tmpdir(), "start-shadcn-proof-"));
const packs = join(scratch, "packs");
const registry = join(scratch, "r");
const consumer = join(scratch, "app");
await Promise.all([packs, registry, consumer].map((dir) => mkdir(dir)));
console.log(`Proof folder: ${scratch}`);
const env = { ...process.env, CI: "true", npm_config_audit: "false", npm_config_fund: "false" };
const servers = [];
const mailSource = join(app, "src/backend/mail.ts");
const original = await readFile(mailSource, "utf8");

function run(command, args, cwd = consumer, extra = {}) {
  console.log(`\n$ ${command} ${args.join(" ")} (cwd ${cwd})`);
  const child = spawnSync(command, args, {
    cwd,
    env: { ...env, ...extra },
    encoding: "utf8",
    timeout: 240000,
  });
  process.stdout.write(child.stdout ?? "");
  process.stdout.write(child.stderr ?? "");
  console.log(`EXIT ${child.status}`);
  assert.equal(child.status, 0, `${command}: ${child.error ?? "failed"}`);
  return child.stdout + child.stderr;
}

async function hashes(dir) {
  const result = {};
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await visit(file);
      else
        result[relative(dir, file)] = createHash("sha256")
          .update(await readFile(file))
          .digest("hex");
    }
  }
  await visit(dir);
  return result;
}

async function stop(child) {
  if (child.exitCode !== null) return;
  const closed = new Promise((done) => child.once("exit", done));
  child.kill("SIGTERM");
  await closed;
  console.log(`Stopped server PID ${child.pid}.`);
}

try {
  for (const name of ["core", "react"])
    run("vp", ["pm", "pack", "--pack-destination", packs], join(root, "packages", name));
  run(process.execPath, [join(root, "packages/start/scripts/pack.mjs"), packs], root);
  const release = join(scratch, "new-base");
  await mkdir(release);
  run("tar", ["-xzf", join(packs, "tinker-start-0.7.0.tgz"), "-C", release], root);
  const releaseRoot = join(release, "package");
  const next = JSON.parse(await readFile(join(releaseRoot, "package.json"), "utf8"));
  next.version = "0.7.1";
  await writeFile(join(releaseRoot, "package.json"), JSON.stringify(next, null, 2) + "\n");
  run("vp", ["pm", "pack", "--pack-destination", packs], releaseRoot);
  console.log("Assumption: 0.7.1 is a local version-bump fixture, not a published release.");
  const staticServer = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { createServer } from 'node:http';
    import { readFile } from 'node:fs/promises';
    import { join, basename } from 'node:path';
    const server = createServer(async (req, res) => {
      try {
        const bytes = await readFile(join(process.argv[1], basename(new URL(req.url, 'http://localhost').pathname)));
        res.setHeader('content-type', 'application/json'); res.end(bytes);
      } catch { res.writeHead(404); res.end(); }
    });
    server.listen(0, '127.0.0.1', () => process.send(server.address().port));
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  `,
      registry,
    ],
    { stdio: ["ignore", "inherit", "inherit", "ipc"] },
  );
  servers.push(staticServer);
  const port = await new Promise((done, fail) => {
    staticServer.once("message", done);
    staticServer.once("error", fail);
  });
  const url = `http://127.0.0.1:${port}/r`;
  console.log(`Local registry ${url}; server PID ${staticServer.pid}.`);
  const buildRegistry = () =>
    run(process.execPath, [join(app, "maintain/build-registry.mjs")], app, {
      TINKER_PACKAGE_DIR: packs,
      TINKER_REGISTRY_URL: url,
      TINKER_REGISTRY_OUT: registry,
    });
  buildRegistry();
  assert.deepEqual(await readdir(consumer), []);
  run("npx", ["--yes", "shadcn@4.21.0", "add", `${url}/app.json`, "--yes"]);
  console.log("PASS: one shadcn add wrote the empty app.");
  run("npm", ["install"]);
  run("vp", ["build"]);
  const tinker = join(consumer, "node_modules/.bin/tinker");
  run(tinker, ["doctor"]);
  const probe = createServer();
  await new Promise((done) => probe.listen(0, "127.0.0.1", done));
  const hostPort = probe.address().port;
  await new Promise((done) => probe.close(done));
  const host = spawn(tinker, ["serve"], {
    cwd: consumer,
    env: { ...env, HOST: "127.0.0.1", PORT: String(hostPort) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  servers.push(host);
  const hostUrl = await new Promise((done, fail) => {
    let output = "";
    host.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) done(match[0]);
    });
    host.once("error", fail);
    host.once("exit", (code) => fail(new Error(`host exited ${code}`)));
  });
  console.log(`App server PID ${host.pid}: ${hostUrl}`);
  const html = run("curl", ["--fail", "--silent", `${hostUrl}/`]);
  assert.ok(html.includes("Hello, world."));
  console.log("PASS: GET / returned Hello, world. (HTTP 200).");
  await stop(host);
  run("npx", ["--yes", "shadcn@4.21.0", "add", `${url}/mail-example.json`, "--yes"]);
  run("vp", ["build"]);
  run(tinker, ["doctor"]);
  console.log("PASS: standalone mail builds and passes doctor without Postgres or SMTP.");
  const baseBefore = await hashes(join(consumer, "node_modules/@tinker/start"));
  const userBefore = await hashes(join(consumer, "src"));
  const packageBefore = await readFile(join(consumer, "package.json"), "utf8");
  await writeFile(mailSource, original.replace('"mail.completed"', '"mail.completed.changed"'));
  buildRegistry();
  const diff = run("npx", [
    "--yes",
    "shadcn@4.21.0",
    "add",
    `${url}/mail-example.json`,
    "--diff",
    "src/backend/mail.ts",
  ]);
  assert.ok(diff.includes("mail.completed.changed"));
  assert.deepEqual(await hashes(join(consumer, "src")), userBefore);
  assert.deepEqual(await hashes(join(consumer, "node_modules/@tinker/start")), baseBefore);
  assert.equal(await readFile(join(consumer, "package.json"), "utf8"), packageBefore);
  console.log(
    "PASS: source change appears in --diff; user files, package.json, and every base byte stay unchanged.",
  );
  await writeFile(mailSource, original);
  buildRegistry();
  const configBefore = {};
  for (const name of [
    "vite.config.ts",
    "tsconfig.json",
    "components.json",
    ".env.example",
    ".gitignore",
  ])
    configBefore[name] = await readFile(join(consumer, name), "utf8");
  run(tinker, ["upgrade", "0.7.1", "--from", packs]);
  assert.deepEqual(await hashes(join(consumer, "src")), userBefore);
  for (const [name, content] of Object.entries(configBefore))
    assert.equal(await readFile(join(consumer, name), "utf8"), content);
  console.log(
    "PASS: upgrade 0.7.0 -> 0.7.1 changed no user source or config; package.json and install files changed as expected.",
  );
  run("npx", [
    "--yes",
    "shadcn@4.21.0",
    "add",
    `${url}/todos-example.json`,
    "--yes",
    "--overwrite",
  ]);
  await cp(join(consumer, ".env.example"), join(consumer, ".env"));
  run("vp", ["build"]);
  run(tinker, ["doctor"]);
  for (const name of ["profile-example", "auth-pages-example", "counter-example", "example-wiring"])
    run("npx", ["--yes", "shadcn@4.21.0", "add", `${url}/${name}.json`, "--yes", "--overwrite"]);
  run("vp", ["build"]);
  run(tinker, ["doctor"]);
  console.log(
    "PASS: todos, profile, auth pages, counter, wiring build and doctor EXIT 0 without a running Postgres.",
  );
  console.log(
    "These demo items enable auth + sync and need Postgres + SMTP for live use. Their shared dependency copies all demo bodies.",
  );
  console.log(
    "NOT PROVEN: live copied demo auth/sync/mail, public registry hosting, or published private packages.",
  );
} finally {
  await writeFile(mailSource, original);
  for (const child of servers.reverse()) await stop(child);
}
console.log("PASS: all proof servers stopped by PID. Nothing published.");
