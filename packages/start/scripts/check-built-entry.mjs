import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const child = `
import assert from "node:assert/strict";
const built = await import("./dist/server/server.js");
console.log("built app entry: loaded");
if (process.argv[1] !== "close-only") {
  const response = await built.default.fetch(new Request("http://localhost/api/health"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
}
const closing = built.default.close();
assert.equal(built.default.close(), closing);
await closing;
console.log("built app entry: " + process.argv[1] + "; closed once; EXIT 0");
`;

for (const app of process.argv.slice(2)) {
  for (const mode of ["health-200", "close-only"]) {
    const ran = spawnSync(process.execPath, ["--input-type=module", "-e", child, mode], {
      cwd: resolve(app),
      env: { ...process.env, NODE_ENV: "production" },
      encoding: "utf8",
      timeout: 30000,
    });
    process.stdout.write(`${app}\n${ran.stdout}${ran.stderr}`);
    assert.equal(ran.status, 0, `${app}: built server must start and close through its app entry`);
  }
}
