import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, root } from "./registry-source.mjs";

/** Real CLI adds, hashes, doctor, builds, and local HTTP; never run inside scope tests. */
const scratch = await mkdtemp(join(tmpdir(), "registry-no-overwrite-"));
const packs = join(scratch, "packs");
const registry = join(scratch, "r");
await Promise.all([packs, registry].map((path) => mkdir(path)));
const env = { ...process.env, CI: "true", npm_config_audit: "false", npm_config_fund: "false" };
const servers = [];
const project = `registry-no-overwrite-${process.pid}`;
const composeFile = join(scratch, "compose.json");
let services = false;
console.log(`Proof folder: ${scratch}`);

console.log(
  "Assumption: feature items keep the existing shared demo bodies together. Nothing is published.",
);

function run(command, args, cwd = root, extra = {}, expected = 0) {
  console.log(`\n$ ${command} ${args.join(" ")} (cwd ${cwd})`);
  const result = spawnSync(command, args, {
    cwd,
    env: { ...env, ...extra },
    encoding: "utf8",
    timeout: 240000,
    maxBuffer: 20 * 1024 * 1024,
  });
  process.stdout.write((result.stdout ?? "").replaceAll("\0", "\\0"));
  process.stdout.write((result.stderr ?? "").replaceAll("\0", "\\0"));
  console.log(`EXIT ${result.status}`);
  assert.equal(result.status, expected, `${command}: ${result.error ?? "unexpected exit"}`);
  return result.stdout + result.stderr;
}

async function freePort() {
  const probe = createServer();
  await new Promise((done) => probe.listen(0, "127.0.0.1", done));
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  return port;
}

async function stop(child) {
  if (child.exitCode !== null) return;
  const closed = new Promise((done) => child.once("exit", done));
  child.kill("SIGTERM");
  await closed;
  console.log(`Stopped server PID ${child.pid}.`);
}

async function hashes(consumer) {
  const result = {};
  for (const file of [
    "vite.config.ts",
    "tsconfig.json",
    "src/lib/tinker.ts",
    "src/lib/tinker.server.ts",
    "src/routes/index.tsx",
    "src/backend/greet.ts",
    ".env.example",
    ".gitignore",
    "components.json",
  ])
    result[file] = createHash("sha256")
      .update(await readFile(join(consumer, file)))
      .digest("hex");
  return result;
}

async function wire(consumer, item) {
  const config = join(consumer, "vite.config.ts");
  await writeFile(
    config,
    (await readFile(config, "utf8")).replace("tinker()", "tinker({ auth: true, sync: true })"),
  );
  for (const [file, names] of Object.entries(item.meta.seams)) {
    const path = join(consumer, file);
    let text = await readFile(path, "utf8");
    for (const needed of Object.values(names)) {
      if (needed.include) {
        text =
          `import { databaseSetup } from "../backend/database.server";
` + text.replace("extensions = []", "extensions = [databaseSetup]");
      } else text += needed.line + "\n";
    }
    await writeFile(path, text);
  }
  await cp(join(consumer, "examples/demo.env.example"), join(consumer, ".env"));
  console.log(
    "Applied doctor's switches and export lines by hand; kept both user seam exports and the user's config setting.",
  );
}

async function serve(consumer, full, serviceEnv) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(join(consumer, "node_modules/.bin/tinker"), ["serve"], {
    cwd: consumer,
    env: { ...env, ...serviceEnv, HOST: "127.0.0.1", PORT: String(port), PUBLIC_ORIGIN: origin },
    stdio: ["ignore", "pipe", "inherit"],
  });
  servers.push(child);
  await new Promise((done, fail) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      output += chunk;
      if (output.includes(origin)) done();
    });
    child.once("error", fail);
    child.once("exit", (code) => fail(new Error(`app server exited ${code}`)));
  });
  console.log(`App server PID ${child.pid}: ${origin}`);
  assert.ok(run("curl", ["--fail", "--silent", `${origin}/`], consumer).includes("Hello, world."));
  if (full)
    assert.ok(
      run("curl", ["--fail", "--silent", `${origin}/demo`], consumer).includes("A shared counter"),
    );
  console.log(
    `PASS: served ${full ? "/ and /demo" : "/"} HTTP 200; original first page still says Hello, world.`,
  );
  await stop(child);
}

try {
  for (const name of ["core", "react"])
    run("vp", ["pm", "pack", "--pack-destination", packs], join(root, "packages", name));
  run(process.execPath, [join(root, "packages/start/scripts/pack.mjs"), packs]);
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
        res.setHeader('content-type', 'application/json');
        res.end(await readFile(join(process.argv[1], basename(new URL(req.url, 'http://localhost').pathname))));
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
  run(process.execPath, [join(app, "maintain/build-registry.mjs")], app, {
    TINKER_PACKAGE_DIR: packs,
    TINKER_REGISTRY_URL: url,
    TINKER_REGISTRY_OUT: registry,
  });
  const postgresPort = await freePort();
  const smtpPort = await freePort();
  await writeFile(
    composeFile,
    JSON.stringify({
      networks: { default: { ipam: { config: [{ subnet: "10.254.250.0/28" }] } } },
      services: {
        postgres: {
          image: "postgres:17.6-alpine",
          command: ["postgres", "-p", "5432"],
          environment: {
            POSTGRES_USER: "app",
            POSTGRES_PASSWORD: "local-proof-password",
            POSTGRES_DB: "app",
          },
          healthcheck: {
            test: ["CMD", "pg_isready", "-U", "app", "-p", "5432"],
            interval: "1s",
            retries: 30,
          },
        },
        mailpit: {
          image: "axllent/mailpit:v1.27.8",
          environment: {
            MP_SMTP_BIND_ADDR: "0.0.0.0:1025",
            MP_UI_BIND_ADDR: "0.0.0.0:8025",
          },
        },
      },
    }),
  );
  services = true;
  run("docker", ["compose", "-p", project, "-f", composeFile, "up", "-d", "--wait"]);
  const relay = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { createServer } from "node:net";
    import { spawn } from "node:child_process";
    import { once } from "node:events";
    const sockets = new Set(), children = new Set(), listeners = [];
    for (const [port, host, target] of ${JSON.stringify([
      [postgresPort, "127.0.0.1", 5432],
      [smtpPort, "mailpit", 1025],
    ])}) {
      const listener = createServer(socket => {
        sockets.add(socket);
        const child = spawn("docker", ["compose", "-p", ${JSON.stringify(project)}, "-f", ${JSON.stringify(composeFile)}, "exec", "-T", "postgres", "nc", host, String(target)], { stdio: ["pipe", "pipe", "inherit"] });
        children.add(child);
        child.stdin.on("error", () => socket.destroy());
        socket.on("error", () => child.kill("SIGTERM"));
        socket.on("close", () => { sockets.delete(socket); child.kill("SIGTERM"); });
        child.on("close", () => { children.delete(child); socket.destroy(); });
        socket.pipe(child.stdin); child.stdout.pipe(socket);
      });
      listener.listen(port, "127.0.0.1"); await once(listener, "listening"); listeners.push(listener);
    }
    process.send("relays ready");
    process.once("SIGTERM", async () => {
      for (const socket of sockets) socket.destroy();
      for (const child of children) child.kill("SIGTERM");
      await Promise.all(listeners.map(listener => new Promise(done => listener.close(done))));
      process.disconnect();
    });
  `,
    ],
    { stdio: ["ignore", "inherit", "inherit", "ipc"] },
  );
  servers.push(relay);
  await new Promise((done, fail) => {
    relay.once("message", done);
    relay.once("error", fail);
    relay.once("exit", (code) => fail(new Error(`relay exited ${code}`)));
  });
  console.log(
    `Own TCP relay PID ${relay.pid} reaches Postgres and Mailpit through docker compose exec; Docker host loopback is outside this workspace.`,
  );
  const serviceEnv = {
    DATABASE_URL: `postgres://app:local-proof-password@127.0.0.1:${postgresPort}/app`,
    AUTH_SECRET: "registry-local-proof-secret-at-least-32-characters",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(smtpPort),
  };
  const index = JSON.parse(await readFile(join(registry, "registry.json"), "utf8"));
  for (const item of index.items.filter((item) => item.name !== "app")) {
    const consumer = join(scratch, item.name);
    await mkdir(consumer);
    run("npx", ["--yes", "shadcn@4.21.0", "add", `${url}/app.json`, "--yes"], consumer);
    run("npm", ["install"], consumer);
    const config = join(consumer, "vite.config.ts");
    await writeFile(
      config,
      (await readFile(config, "utf8")).replace(
        "plugins:",
        'define: { __USER_KEEP__: JSON.stringify("keep-config") },\n  plugins:',
      ),
    );
    for (const [file, name] of [
      ["tinker.ts", "client"],
      ["tinker.server.ts", "server"],
    ]) {
      const path = join(consumer, "src/lib", file);
      await writeFile(
        path,
        (await readFile(path, "utf8")) + `export const user${name} = "keep-${name}";\n`,
      );
    }
    const before = await hashes(consumer);
    const scripts = JSON.parse(await readFile(join(consumer, "package.json"), "utf8")).scripts;
    console.log(`${item.name}: sha256 BEFORE ${JSON.stringify(before)}`);
    run("npx", ["--yes", "shadcn@4.21.0", "add", `${url}/${item.name}.json`, "--yes"], consumer);
    const after = await hashes(consumer);
    console.log(`${item.name}: sha256 AFTER ${JSON.stringify(after)}`);
    assert.deepEqual(after, before);
    assert.deepEqual(
      JSON.parse(await readFile(join(consumer, "package.json"), "utf8")).scripts,
      scripts,
    );
    console.log(
      `PASS: ${item.name} added to a fresh app without --overwrite; edited config and both seams unchanged byte for byte; app scripts unchanged.`,
    );
    const tinker = join(consumer, "node_modules/.bin/tinker");
    const full = item.meta.parts?.includes("sync") ?? false;
    const report = run(tinker, ["doctor"], consumer, {}, full ? 1 : 0);
    if (full) {
      const plain = report.replace(/\s+/g, " ");
      for (const part of item.meta.parts) assert.ok(plain.includes(`tinker({ ${part}: true })`));
      for (const names of Object.values(item.meta.seams))
        for (const needed of Object.values(names)) assert.ok(plain.includes(needed.line));
      await wire(consumer, item);
    }
    run("vp", ["build"], consumer);
    run(tinker, ["doctor"], consumer);
    await serve(consumer, full, serviceEnv);
    console.log(`PASS: ${item.name}: build, doctor, serve EXIT 0.`);
  }
  console.log(
    "NOT PROVEN: independent feature bodies, copied-demo sign-in or mail sends, public registry hosting, published packages, or future releases.",
  );
} finally {
  for (const child of servers.reverse()) await stop(child);
  if (services) run("docker", ["compose", "-p", project, "-f", composeFile, "down", "-v"]);
}

console.log(
  "PASS: all proof servers stopped by PID; own Compose project removed. Nothing published.",
);
