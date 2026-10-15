import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const child = `
import assert from "node:assert/strict";
import { createScope } from "@tinker/core";
const mode = process.argv[1];
const probe = { created: 0, closed: [], env: 0, createScope(...args) {
  const id = ++this.created;
  const scope = createScope(...args);
  void scope.closed.then(() => this.closed.push(id));
  return scope;
}};
globalThis.__entryProof = probe;
const loadEnvFile = process.loadEnvFile;
process.loadEnvFile = (...args) => { probe.env++; return loadEnvFile(...args); };
// Resolve stdio before taking the handle snapshot; the import must write nothing.
void process.stdout;
void process.stderr;
const resources = process.getActiveResourcesInfo().filter((name) => !name.startsWith("FSReq")).sort();
const { default: main } = await import(process.env.ENTRY_PROOF);
assert.equal(probe.env, 0, "import must not read app inputs");
assert.equal(probe.created, 0, "import must not create a scope");
if (mode.startsWith("import")) {
  await new Promise(setImmediate);
  assert.deepEqual(process.getActiveResourcesInfo().filter((name) => !name.startsWith("FSReq")).sort(), resources);
} else {
  const server = await main();
  const replies = await Promise.all([1, 2].map(() => server.fetch(new Request("http://localhost/api/health"))));
  for (const reply of replies) {
    assert.equal(reply.status, 200);
    assert.equal((await reply.json()).ok, true);
  }
  assert.equal(probe.env, 1, "main reads inputs once");
  assert.equal(probe.created, 2, "only the two server roots start");
  await Promise.all([server.close(), server.close()]);
  assert.deepEqual(probe.closed, [2, 1], "close ends app then tools once");
}
`;

for (const app of process.argv.slice(2)) {
  const root = resolve(app);
  const entry = join(root, "dist/server/server.js");
  const source = readFileSync(entry, "utf8");
  const copy = join(root, "dist/server", `entry-proof-${randomUUID()}.mjs`);

  // Count real Core calls in a throwaway copy; keep the built entry untouched.
  assert.equal(source.match(/\bcreateScope\(/g)?.length, 2, "plant both real root calls");
  writeFileSync(copy, source.replaceAll("createScope(", "globalThis.__entryProof.createScope("));
  try {
    for (const mode of ["import-original", "import-counted", "main"]) {
      const ran = spawnSync(process.execPath, ["--input-type=module", "-e", child, mode], {
        cwd: root,
        env: {
          ...process.env,
          NODE_ENV: "production",
          ENTRY_PROOF: mode === "import-original" ? entry : copy,
        },
        encoding: "utf8",
        timeout: 30000,
      });
      assert.equal(ran.status, 0, `${app}: ${mode}\n${ran.stdout}${ran.stderr}`);
      if (mode.startsWith("import")) {
        assert.equal(ran.stdout, "", "import must write no stdout");
        assert.equal(ran.stderr, "", "import must write no stderr");
      }
      console.log(
        `PASS built entry: ${mode}; no eager effects, explicit main, ordered close; EXIT 0`,
      );
    }
  } finally {
    rmSync(copy);
  }
}
