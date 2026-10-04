import { cp, mkdtemp, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const source = resolve(import.meta.dirname, "..");
const proof = await mkdtemp(join(tmpdir(), "start-import-guard-"));
try {
  for (const name of ["src", "package.json", "vite.config.ts", "tsconfig.json"]) {
    await cp(join(source, name), join(proof, name), { recursive: true });
  }
  await symlink(join(source, "node_modules"), join(proof, "node_modules"), "dir");
  const router = join(proof, "src/router.tsx");
  const original = await readFile(router, "utf8");
  const components = JSON.parse(await readFile(join(source, "components.json"), "utf8"));
  await writeFile(
    join(proof, "src/backend/http.ts"),
    'export { database } from "./database.ts";\n',
  );
  for (const [specifier, unit] of [
    ["./backend/index.ts", "database"],
    ["./backend/http.ts", "database"],
    [`${components.aliases.lib}/tinker.server`, "database"],
    ["./scaffold/backend/http.ts", "httpRequest"],
  ]) {
    await writeFile(
      router,
      `import { ${unit} } from "${specifier}";\ndocument.title = ${unit}.label;\n${original}`,
    );
    const result = spawnSync("vp", ["build"], { cwd: proof, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Import denied in client environment/);
    process.stdout.write(`PASS: a browser import of ${specifier} fails the build.\n`);
  }
} finally {
  await rm(proof, { recursive: true, force: true });
}
