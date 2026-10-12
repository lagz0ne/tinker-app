import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** First run of a new app: settings with a fresh secret, local services, then packages. */
const app = resolve(import.meta.dirname, "..");
const env = join(app, ".env");

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: app, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

if (existsSync(env)) {
  console.log(".env exists; kept as it is.");
} else {
  const sample = readFileSync(join(app, ".env.example"), "utf8");
  const secret = randomBytes(32).toString("base64url");
  writeFileSync(env, sample.replace(/^AUTH_SECRET=.*$/m, `AUTH_SECRET=${secret}`));
  console.log("Wrote .env with a new AUTH_SECRET.");
}

run("docker", ["compose", "up", "-d", "--wait"]);

if (!existsSync(join(app, "node_modules"))) run("npm", ["install"]);

console.log("Ready. Run: npm run dev");
