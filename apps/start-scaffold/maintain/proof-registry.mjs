import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import {
  proofEnv,
  wireProofMail,
  missingMailChild,
  pasteToolchain,
  printedToolchain,
  sqliteAppTest,
} from "./proof-app.mjs";
import { app, root } from "./registry-source.mjs";

/** Real shadcn, packed releases, and HTTP; this proof stays outside scope tests. */
const scratch = await mkdtemp(join(tmpdir(), "start-shadcn-proof-"));
const packs = join(scratch, "packs");
const registry = join(scratch, "r");
const consumer = join(scratch, "app");
const sqliteApp = join(scratch, "sqlite-app");
await Promise.all([packs, registry, consumer, sqliteApp].map((dir) => mkdir(dir)));
console.log(`Proof folder: ${scratch}`);

const env = {
  ...process.env,
  ...proofEnv,
  CI: "true",
  npm_config_audit: "false",
  npm_config_fund: "false",
};

const servers = [];
const mailTarget = "tinker/components/mail/mail.server.ts";
const original = await readFile(join(app, mailTarget), "utf8");

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
      else {
        result[relative(dir, file)] = createHash("sha256")
          .update(await readFile(file))
          .digest("hex");
      }
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
  run(process.execPath, [join(root, "packages/start/scripts/pack.mjs"), packs], root);

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

  // G0b: the SQLite set lands on the `app` item. The user pastes only what tinker add printed.
  run(
    "npx",
    ["--yes", "shadcn@4.21.0", "add", `${url}/app.json`, "--yes", "--overwrite"],
    sqliteApp,
  );
  run("npm", ["install"], sqliteApp);
  const sqliteTinker = join(sqliteApp, "node_modules/.bin/tinker");
  const added = run(sqliteTinker, ["add", "database-sqlite", "--registry", url], sqliteApp);
  const toolchain = printedToolchain(added);
  for (const name of ["sync-sqlite", "auth-sqlite"]) {
    const more = run(sqliteTinker, ["add", name, "--registry", url], sqliteApp);
    assert.ok(!more.includes("Paste into your toolchain"), `${name}: the toolchain prints once`);
  }
  await pasteToolchain(sqliteApp, toolchain);
  run("npm", ["install"], sqliteApp);
  await mkdir(join(sqliteApp, "tests"), { recursive: true });
  await writeFile(join(sqliteApp, "tests/sqlite.test.ts"), sqliteAppTest);
  run("vp", ["build"], sqliteApp);
  const typecheck = run("npm", ["run", "typecheck"], sqliteApp);
  assert.ok(typecheck.includes("--runExternalCode"), "the pasted type check runs Reylo");
  run("vp", ["test", "--run"], sqliteApp);
  run(sqliteTinker, ["check", "--registry", url], sqliteApp);
  run(sqliteTinker, ["doctor"], sqliteApp);
  console.log(
    "PASS: an app item app adds database-sqlite, sync-sqlite and auth-sqlite, pastes the printed toolchain, builds, type-checks with --runExternalCode and runs a database test.",
  );

  assert.deepEqual(await readdir(consumer), []);
  run("npx", ["--yes", "shadcn@4.21.0", "add", `${url}/app.json`, "--yes", "--overwrite"]);
  const installed = JSON.parse(await readFile(join(consumer, "package.json"), "utf8"));
  assert.ok(
    installed.devDependencies?.["@tinker/start"],
    "app package file must replace only the CLI-created dependency stub",
  );
  await readFile(join(consumer, "vite.config.ts"));
  console.log("PASS: one shadcn add wrote the empty app.");

  run("npm", ["install"]);
  run("vp", ["build"]);
  const tinker = join(consumer, "node_modules/.bin/tinker");
  run(tinker, ["doctor"]);
  run(process.execPath, [join(root, "packages/start/scripts/check-entry-hmr.mjs"), consumer]);

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
  await wireProofMail(consumer);
  run("vp", ["build"]);
  run(tinker, ["doctor"]);
  run(process.execPath, ["--input-type=module", "-e", missingMailChild], consumer, {
    SMTP_FROM: undefined,
  });
  console.log(
    "PASS: standalone mail builds, passes doctor and rejects a missing startup tag and no running Postgres or SMTP.",
  );

  const baseBefore = await hashes(join(consumer, "node_modules/@tinker/start"));
  const userBefore = await hashes(join(consumer, "src"));
  const packageBefore = await readFile(join(consumer, "package.json"), "utf8");

  // A candidate release changes only the served scratch payload; golden source stays intact.
  const candidatePath = join(registry, "mail.json");
  const candidate = JSON.parse(await readFile(candidatePath, "utf8"));
  const mailFile = candidate.files.find((file) => file.target === `~/${mailTarget}`);
  assert.ok(mailFile.content.includes('"mail.completed"'));
  mailFile.content = mailFile.content.replace('"mail.completed"', '"mail.completed.changed"');
  await writeFile(candidatePath, JSON.stringify(candidate, null, 2) + "\n");
  const configBefore = {};
  for (const name of [
    "vite.config.ts",
    "tsconfig.json",
    "components.json",
    ".env.example",
    ".gitignore",
  ]) {
    configBefore[name] = await readFile(join(consumer, name), "utf8");
  }
  const cmdsBefore = await hashes(join(consumer, "cmds"));

  const diff = run("npx", [
    "--yes",
    "shadcn@4.21.0",
    "add",
    `${url}/mail.json`,
    "--diff",
    "tinker/components/mail/mail.server.ts",
  ]);
  assert.ok(diff.includes("mail.completed.changed"));
  assert.deepEqual(await hashes(join(consumer, "src")), userBefore);
  assert.deepEqual(await hashes(join(consumer, "node_modules/@tinker/start")), baseBefore);
  assert.equal(await readFile(join(consumer, "package.json"), "utf8"), packageBefore);
  console.log(
    "PASS: source change appears in --diff; user files, package.json, and every base byte stay unchanged.",
  );

  assert.deepEqual(await hashes(join(consumer, "cmds")), cmdsBefore);
  for (const [name, content] of Object.entries(configBefore)) {
    assert.equal(await readFile(join(consumer, name), "utf8"), content);
  }
  await writeFile(
    join(consumer, mailTarget),
    (await readFile(join(consumer, mailTarget), "utf8")) + "\n// local-edit-to-replace\n",
  );
  run("npx", ["--yes", "shadcn@4.21.0", "add", `${url}/mail.json`, "--yes", "--overwrite"]);
  const updated = await readFile(join(consumer, mailTarget), "utf8");
  assert.ok(
    updated.includes("mail.completed.changed") && !updated.includes("local-edit-to-replace"),
  );
  assert.deepEqual(await hashes(join(consumer, "src")), userBefore);
  assert.deepEqual(await hashes(join(consumer, "cmds")), cmdsBefore);
  for (const [name, content] of Object.entries(configBefore)) {
    assert.equal(await readFile(join(consumer, name), "utf8"), content);
  }
  assert.equal(await readFile(join(app, mailTarget), "utf8"), original);
  console.log(
    "PASS: component update replaces its file whole; app source, commands, config, and golden source stay intact.",
  );

  run("npx", ["--yes", "shadcn@4.21.0", "add", `${url}/todos-example.json`, "--yes"]);
  for (const name of ["server.ts", "router.ts"]) {
    await cp(join(app, "cmds", name), join(consumer, "cmds", name));
  }
  await cp(join(consumer, "examples/demo-root.tsx"), join(consumer, "src/routes/__root.tsx"));
  await cp(join(consumer, "examples/demo-style.css"), join(consumer, "src/style.css"));

  run("vp", ["build"]);
  run(tinker, ["doctor"]);

  for (const name of [
    "profile-example",
    "auth-pages-example",
    "counter-example",
    "example-wiring",
  ]) {
    run("npx", ["--yes", "shadcn@4.21.0", "add", `${url}/${name}.json`, "--yes"]);
  }

  run("vp", ["build"]);
  run(tinker, ["doctor"]);

  console.log(
    "PASS: todos, profile, auth pages, counter, wiring build and doctor EXIT 0 without a running Postgres.",
  );

  console.log(
    "These demo items need hand-written command bindings and Postgres + SMTP for live use. Their shared dependency copies all demo bodies.",
  );
  console.log(
    "NOT PROVEN: live copied demo auth/sync/mail, public registry hosting, or published private packages.",
  );
} finally {
  for (const child of servers.reverse()) await stop(child);
}

console.log("PASS: all proof servers stopped by PID. Nothing published.");
