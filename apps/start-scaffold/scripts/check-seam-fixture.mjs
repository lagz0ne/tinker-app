import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const app = resolve(import.meta.dirname, "..");
const fixture = await mkdtemp(join(tmpdir(), "start-seam-note-"));
try {
  await mkdir(join(fixture, "src/lib"), { recursive: true });
  await cp(join(app, "src/scaffold"), join(fixture, "src/scaffold"), { recursive: true });
  for (const file of await readdir(join(app, "scripts/fixtures/note-app"))) {
    const name = file.replace(/\.txt$/, "");
    const target = name.startsWith("tinker.") ? `src/lib/${name}` : `src/${name}`;
    await writeFile(
      join(fixture, target),
      await readFile(join(app, "scripts/fixtures/note-app", file)),
    );
  }
  await writeFile(join(fixture, "package.json"), '{"type":"module"}\n');
  await writeFile(join(fixture, "tsconfig.json"), await readFile(join(app, "tsconfig.json")));
  await symlink(join(app, "node_modules"), join(fixture, "node_modules"), "dir");
  assert.deepEqual((await readdir(join(fixture, "src"))).sort(), [
    "contracts.ts",
    "lib",
    "records.ts",
    "routeTree.gen.ts",
    "scaffold",
    "server.ts",
  ]);
  const result = spawnSync(join(app, "node_modules/.bin/tsc"), ["--noEmit"], {
    cwd: fixture,
    encoding: "utf8",
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  assert.equal(
    result.status,
    0,
    "The copied scaffold must compile with notes, without example feature files.",
  );
  console.log("PASS: copied scaffold + note app + its own Register; tsc --noEmit EXIT 0.");
} finally {
  await rm(fixture, { recursive: true, force: true });
}
