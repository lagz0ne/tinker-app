import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

/** Start local services and install packages. The user owns every config tag binding. */
const app = resolve(import.meta.dirname, "..");

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: app, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run("docker", ["compose", "up", "-d", "--wait"]);

// Always install: an interrupted first install leaves node_modules behind.
run("npm", ["install"]);

console.log("Fill the required tags in cmds/server.ts, then run npm run dev.");
