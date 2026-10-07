import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";

/** Real Postgres, better-auth, Mailpit, and two Lightpanda tabs. This is a proof, never a test. */
const repo = resolve(import.meta.dirname, "../../..");
const app = join(repo, "apps/start-scaffold");
const logFile =
  process.env.SCAFFOLD_PROOF_LOG ??
  join(repo, "docs/roadmap/start-base/proof/16-scaffold-on-base.txt");
const scratch = await mkdtemp(join(tmpdir(), "scaffold-on-base-"));
const rows = [];
const say = (line) => {
  rows.push(line);
  console.log(line);
};
const project = `scaffold-on-base-${process.pid}`;
const session = `scaffold-on-base-${process.pid}`;
const otherSession = `${session}-two`;
let activeSession = session;
const openedSessions = new Set();
const ports = [];
for (let n = 0; n < 4; n++) {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  ports.push(listener.address().port);
  await new Promise((done) => listener.close(done));
}
const [port, postgresPort, smtpPort, mailpitPort] = ports;
const origin = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  HOST: "127.0.0.1",
  PORT: String(port),
  PUBLIC_ORIGIN: origin,
  AUTH_SECRET: "scaffold-proof-local-only-secret-at-least-32-letters",
  POSTGRES_USER: "app",
  POSTGRES_PASSWORD: "local-proof-password",
  POSTGRES_DB: "app",
  POSTGRES_PORT: String(postgresPort),
  DATABASE_URL: `postgres://app:local-proof-password@127.0.0.1:${postgresPort}/app`,
  SMTP_HOST: "127.0.0.1",
  SMTP_PORT: String(smtpPort),
  SMTP_USER: "",
  SMTP_PASSWORD: "",
  SMTP_FROM: "proof@example.com",
  MAILPIT_PORT: String(mailpitPort),
  VICTORIA_TRACES_PORT: "11428",
  VICTORIA_LOGS_PORT: "19428",
  OTEL_SERVICE_NAME: "scaffold-proof",
  VICTORIA_TRACES_URL: "http://127.0.0.1:1/insert/opentelemetry/v1/traces",
  VICTORIA_LOGS_URL: "http://127.0.0.1:1/insert/jsonline",
};
const composeOverride = join(scratch, "compose-network.yml");
await writeFile(
  composeOverride,
  "networks:\n  default:\n    ipam:\n      config:\n        - subnet: 10.254.251.0/28\n",
);
const compose = (...args) => {
  const result = spawnSync(
    "docker",
    ["compose", "-p", project, "-f", "compose.yml", "-f", composeOverride, ...args],
    {
      cwd: app,
      env,
      encoding: "utf8",
      timeout: 120000,
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
};
const browser = (...args) => {
  const result = spawnSync("agent-browser", ["--session", activeSession, ...args], {
    cwd: app,
    env,
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
};
const cookie = join(scratch, "cookies.txt");
const authCurl = (path, body) => {
  const result = spawnSync(
    "curl",
    [
      "-fsS",
      "-c",
      cookie,
      "-b",
      cookie,
      "-H",
      "content-type: application/json",
      "-H",
      `origin: ${origin}`,
      "-d",
      JSON.stringify(body),
      `${origin}/api/auth/${path}`,
    ],
    { encoding: "utf8", timeout: 30000 },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};
let mailpitOrigin = `http://127.0.0.1:${mailpitPort}`;
let relay;
let server;
let startedCompose = false;
let serverOutput = "";
let failed;
try {
  say("scaffold on @tinker/start; telemetry, auth, sync on");
  const build = spawnSync("vp", ["build"], { cwd: app, env, encoding: "utf8", timeout: 120000 });
  say(`vp build: EXIT ${build.status}`);
  assert.equal(build.status, 0, build.stdout + build.stderr);
  const doctor = spawnSync("node", ["node_modules/@tinker/start/bin/tinker.mjs", "doctor"], {
    cwd: app,
    env,
    encoding: "utf8",
    timeout: 30000,
  });
  say(doctor.stdout.trim());
  say(`tinker doctor: EXIT ${doctor.status}`);
  assert.equal(doctor.status, 0, doctor.stderr);
  startedCompose = true;
  compose("up", "-d", "--wait", "postgres", "mailpit");
  say("docker compose up --wait postgres mailpit: EXIT 0; isolated proof project");
  say("Own network uses 10.254.251.0/28; the host default address pools are full");
  relay = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { createServer } from "node:net";
    import { spawn } from "node:child_process";
    import { once } from "node:events";
    const sockets = new Set();
    const children = new Set();
    const servers = [];
    for (const [port, host, target] of ${JSON.stringify([
      [postgresPort, "127.0.0.1", 5432],
      [smtpPort, "mailpit", 1025],
      [mailpitPort, "mailpit", 8025],
    ])}) {
      const server = createServer((socket) => {
        sockets.add(socket);
        const child = spawn("docker", ["compose", "-p", ${JSON.stringify(project)}, "-f", "compose.yml", "-f", ${JSON.stringify(composeOverride)},
          "exec", "-T", "postgres", "nc", host, String(target)], { stdio: ["pipe", "pipe", "pipe"] });
        children.add(child);
        child.stderr.on("data", (chunk) => process.stderr.write(chunk));
        child.stdin.on("error", () => socket.destroy());
        socket.on("error", () => child.kill("SIGTERM"));
        socket.on("close", () => { sockets.delete(socket); child.kill("SIGTERM"); });
        child.on("close", () => { children.delete(child); socket.destroy(); });
        socket.pipe(child.stdin);
        child.stdout.pipe(socket);
      });
      server.listen(port, "127.0.0.1");
      await once(server, "listening");
      servers.push(server);
    }
    process.stdout.write("relays ready\\n");
    process.once("SIGTERM", async () => {
      for (const socket of sockets) socket.destroy();
      for (const child of children) child.kill("SIGKILL");
      await Promise.all(servers.map(server => new Promise(done => server.close(done))));
    });
  `,
    ],
    { cwd: app, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let relayErrors = "";
  relay.stderr.on("data", (chunk) => (relayErrors += chunk));
  const ready = await Promise.race([
    once(relay.stdout, "data"),
    once(relay, "close").then(() => {
      throw new Error(relayErrors || "relay exited");
    }),
  ]);
  assert.ok(String(ready[0]).includes("relays ready"));
  say(
    "Own TCP relays reach Postgres and Mailpit through docker compose exec; host loopback is outside this workspace",
  );
  const migration = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import pg from "pg";
    import { drizzle } from "drizzle-orm/node-postgres";
    import { migrate } from "drizzle-orm/node-postgres/migrator";
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    try { await migrate(drizzle({ client: pool }), { migrationsFolder: "drizzle" }); }
    catch (error) { console.error(error); process.exitCode = 1; }
    finally { await pool.end(); }
  `,
    ],
    { cwd: app, env, encoding: "utf8", timeout: 30000 },
  );
  say(`run app migrations: EXIT ${migration.status}`);
  assert.equal(migration.status, 0, migration.stderr);
  server = spawn("node", ["node_modules/@tinker/start/bin/tinker.mjs", "serve"], {
    cwd: app,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => (serverOutput += chunk));
  server.stderr.on("data", (chunk) => (serverOutput += chunk));
  const deadline = AbortSignal.timeout(30000);
  let health;
  while (!health) {
    deadline.throwIfAborted();
    assert.equal(server.exitCode, null, serverOutput);
    try {
      health = await fetch(`${origin}/api/health`, { signal: deadline });
    } catch (error) {
      if (error.cause?.code !== "ECONNREFUSED") throw error;
      await setImmediate();
    }
  }
  assert.equal(health.status, 200, serverOutput + (await health.clone().text()));
  say(`GET /api/health: ${health.status} ${await health.text()}`);
  const migrated = compose(
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "app",
    "-d",
    "app",
    "-Atc",
    "SELECT count(*) FROM drizzle.__drizzle_migrations",
  );
  assert.equal(migrated, "4");
  say(`databaseSetup ran app migrations: ${migrated} migration rows on real Postgres`);
  const signup = authCurl("sign-up/email", {
    name: "Step One",
    email: "step-one@example.com",
    password: "safe-password-42",
  });
  assert.equal(signup.user.email, "step-one@example.com");
  say("curl POST /api/auth/sign-up/email: 200; account step-one@example.com");
  const mail = await (await fetch(`${mailpitOrigin}/api/v1/messages`)).json();
  assert.ok(mail.messages.some((message) => message.Subject === "Check your email"));
  say("Mailpit: real SMTP verification message received");
  authCurl("sign-out", {});
  const signin = authCurl("sign-in/email", {
    email: "step-one@example.com",
    password: "safe-password-42",
  });
  assert.equal(signin.user.id, signup.user.id);
  say("curl POST /api/auth/sign-in/email: 200; same real Postgres account");
  openedSessions.add(session);
  say("browser engine: Lightpanda (agent-browser default); 127.0.0.1 only");
  browser("open", origin);
  browser("find", "role", "button", "click", "--name", "Sign in", "--exact");
  browser("fill", 'input[name="email"]', "step-one@example.com");
  browser("fill", 'input[name="password"]', "safe-password-42");
  browser("click", "form > button");
  browser("wait", "--text", "Open profile");
  say("tab one: real better-auth browser sign-in succeeded");
  browser("open", `${origin}/todos`);
  browser("wait", 'input[name="title"]');
  activeSession = otherSession;
  openedSessions.add(otherSession);
  browser("open", origin);
  browser("find", "role", "button", "click", "--name", "Sign in", "--exact");
  browser("fill", 'input[name="email"]', "step-one@example.com");
  browser("fill", 'input[name="password"]', "safe-password-42");
  browser("click", "form > button");
  browser("wait", "--text", "Open profile");
  browser("open", `${origin}/todos`);
  browser("wait", 'input[name="title"]');
  say(
    "two live Lightpanda tabs: one per session, same real account; Lightpanda permits one target per session",
  );
  activeSession = session;
  const todoTitle = "Step one crosses two tabs";
  browser("fill", 'input[name="title"]', todoTitle);
  browser("find", "role", "button", "click", "--name", "Add todo", "--exact");
  browser("wait", "--text", todoTitle);
  say(`tab one added todo: ${todoTitle}`);
  activeSession = otherSession;
  browser("wait", "--text", todoTitle);
  const shown = browser("eval", "document.body.textContent");
  assert.ok(shown.includes(todoTitle));
  say(`tab two received todo through /api/sync: ${todoTitle}`);
  const requests = browser("network", "requests", "--filter", "/api/sync");
  say(`tab two sync requests: ${requests}`);
  const saved = compose(
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "app",
    "-d",
    "app",
    "-Atc",
    "SELECT title FROM todo ORDER BY id",
  );
  assert.ok(saved.includes(todoTitle));
  say(`Postgres saved todo: ${saved}`);
  activeSession = session;
  browser("open", `${origin}/profile`);
  browser("wait", "form input");
  browser("fill", "form input", "Step two saved name");
  browser("find", "role", "button", "click", "--name", "Save name", "--exact");
  browser("wait", "--text", "Name saved and notification accepted.");
  const notifications = await fetch(`${mailpitOrigin}/api/v1/messages`).then((response) =>
    response.json(),
  );
  assert.ok(
    notifications.messages.some((message) => message.Subject === "Your profile was updated"),
  );
  say("profile page saved name; Mailpit received the real SMTP notification");
  say("PROOF PASS: real auth, SMTP, migrations, two-tab sync, and profile page");
} catch (error) {
  failed = error;
  say(`PROOF FAIL: ${error.message}`);
  await writeFile(join(scratch, "server.log"), serverOutput);
  say(`server log: ${join(scratch, "server.log")}`);
} finally {
  for (const openedSession of openedSessions) {
    activeSession = openedSession;
    try {
      browser("close");
      say("browser session stopped: EXIT 0");
    } catch (error) {
      failed ??= error;
      say(`browser cleanup failed: ${error.message}`);
    }
  }
  if (server && server.exitCode === null) {
    const ended = once(server, "close");
    server.kill("SIGTERM");
    const [code, signal] = await ended;
    say(`server PID ${server.pid} stopped: EXIT ${code}; signal ${signal ?? "none"}`);
    if (code !== 0) failed ??= new Error("server stop failed");
  }
  if (relay && relay.exitCode === null) {
    const ended = once(relay, "close");
    relay.kill("SIGTERM");
    const [code] = await ended;
    say(`relay PID ${relay.pid} stopped: EXIT ${code}`);
  }
  if (startedCompose) {
    try {
      compose("down", "-v");
      say("docker compose down -v: EXIT 0; only the proof project");
    } catch (error) {
      failed ??= error;
      say(`compose cleanup failed: ${error.message}`);
    }
  }
  await writeFile(logFile, rows.join("\n") + "\n");
  if (!failed) await rm(scratch, { recursive: true });
}
if (failed) throw failed;
