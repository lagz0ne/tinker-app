import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const app = resolve(import.meta.dirname, "..");
const repo = resolve(app, "../..");
const stage = await mkdtemp(join(tmpdir(), "start-refine-compose-stage-"));
const container = "start-refine-browser-proof";
const gates = [];

function run(name, command, args) {
  const result = spawnSync(command, args, {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  const log = `/tmp/start-refine-compose-${name}.log`;
  gates.push({ name, code: result.status, log });
  return writeFile(log, result.stdout + result.stderr + `\nEXIT ${result.status}\n`).then(() => {
    console.log(`${name}: EXIT ${result.status}; ${log}`);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}

try {
  await run("pull", "docker", [
    "compose",
    "--project-name",
    "start-refine-proof",
    "--project-directory",
    app,
    "pull",
  ]);
  await run("up", "docker", [
    "compose",
    "--project-name",
    "start-refine-proof",
    "--project-directory",
    app,
    "up",
    "-d",
    "--wait",
  ]);
  await run("browser-image", "docker", ["pull", "mcr.microsoft.com/playwright:v1.55.0-noble"]);
  for (const name of ["core", "react"])
    await run(`pack-${name}`, "pnpm", [
      "--dir",
      join(repo, "packages", name),
      "pack",
      "--out",
      join(stage, `${name}.tgz`),
    ]);
  for (const name of ["dist", "drizzle", ".env"])
    await cp(join(app, name), join(stage, name), { recursive: true });
  await mkdir(join(stage, "scripts"));
  await mkdir(join(stage, "maintain"));
  await cp(join(app, "scripts/serve.mjs"), join(stage, "scripts/serve.mjs"));
  await cp(join(app, "maintain/check-compose.mjs"), join(stage, "maintain/check-compose.mjs"));
  const pkg = JSON.parse(await readFile(join(app, "starter.package.json"), "utf8"));
  delete pkg.devDependencies;
  delete pkg.overrides;
  pkg.dependencies["@tinker/core"] = "file:core.tgz";
  pkg.dependencies["@tinker/react"] = "file:react.tgz";
  pkg.dependencies.playwright = "1.55.0";
  await writeFile(join(stage, "package.json"), JSON.stringify(pkg, null, 2));
  await run("container-create", "docker", [
    "create",
    "--name",
    container,
    "--network",
    "start-refine-proof_default",
    "--user",
    "pwuser",
    "--workdir",
    "/home/pwuser/app",
    "mcr.microsoft.com/playwright:v1.55.0-noble",
    "sleep",
    "infinity",
  ]);
  await run("container-copy", "docker", [
    "cp",
    "-a",
    `${stage}/.`,
    `${container}:/home/pwuser/app`,
  ]);
  await run("container-start", "docker", ["start", container]);
  await run("container-owner", "docker", [
    "exec",
    "--user",
    "root",
    container,
    "chown",
    "-R",
    "pwuser:pwuser",
    "/home/pwuser/app",
  ]);
  await run("container-install", "docker", [
    "exec",
    container,
    "npm",
    "install",
    "--ignore-scripts",
  ]);
  await run("browser", "docker", [
    "exec",
    "-e",
    "DATABASE_URL=postgres://app:local-password@postgres:5432/app",
    "-e",
    "SMTP_HOST=mailpit",
    "-e",
    "SMTP_PORT=1025",
    "-e",
    "VICTORIA_TRACES_URL=http://traces:10428/insert/opentelemetry/v1/traces",
    "-e",
    "VICTORIA_LOGS_URL=http://logs:9428/insert/jsonline",
    "-e",
    "MAILPIT_URL=http://mailpit:8025",
    "-e",
    "COMPOSE_BROWSER_CONTAINER=1",
    container,
    "node",
    "maintain/check-compose.mjs",
  ]);
  await run("copy-proof-json", "docker", [
    "cp",
    `${container}:/tmp/start-refine-compose-proof.json`,
    "/tmp/start-refine-compose-proof.json",
  ]);
} finally {
  await run("copy-host-log", "docker", [
    "cp",
    `${container}:/tmp/start-refine-compose-host.log`,
    "/tmp/start-refine-compose-host.log",
  ]);
  await run("container-remove", "docker", ["rm", "-f", container]);
  await rm(stage, { recursive: true, force: true });
  await writeFile("/tmp/start-refine-compose-gates.json", JSON.stringify(gates, null, 2) + "\n");
}
