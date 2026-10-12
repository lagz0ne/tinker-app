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
  // A registry app keeps the small sample at the root; its added demo brings the full one.
  const copied = join(app, "examples/demo.env.example");
  const sample = readFileSync(existsSync(copied) ? copied : join(app, ".env.example"), "utf8");
  if (!/^AUTH_SECRET=/m.test(sample)) throw new Error("The env sample has no AUTH_SECRET line.");

  const secret = randomBytes(32).toString("base64url");
  writeFileSync(env, sample.replace(/^AUTH_SECRET=.*$/m, `AUTH_SECRET=${secret}`));
  console.log("Wrote .env with a new AUTH_SECRET.");
}

run("docker", ["compose", "up", "-d", "--wait"]);

// Always install: an interrupted first install leaves node_modules behind.
run("npm", ["install"]);

console.log("Ready. Run: npm run dev");
