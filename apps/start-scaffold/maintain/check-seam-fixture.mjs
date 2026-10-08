import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const app = resolve(import.meta.dirname, "..");
const fixture = await mkdtemp(join(tmpdir(), "start-seam-note-"));

try {
  await mkdir(join(fixture, "src/lib"), { recursive: true });
  await mkdir(join(fixture, "src/routes"), { recursive: true });
  for (const file of await readdir(join(app, "maintain/fixtures/note-app"))) {
    const name = file.replace(/\.txt$/, "");
    const target = name.startsWith("tinker.")
      ? `src/lib/${name}`
      : name === "index.tsx"
        ? "src/routes/index.tsx"
        : `src/${name}`;
    await writeFile(
      join(fixture, target),
      await readFile(join(app, "maintain/fixtures/note-app", file)),
    );
  }
  await writeFile(join(fixture, "package.json"), '{"type":"module"}\n');
  await writeFile(join(fixture, "tsconfig.json"), await readFile(join(app, "tsconfig.json")));
  await symlink(join(app, "node_modules"), join(fixture, "node_modules"), "dir");
  await cp(join(app, "vite.config.ts"), join(fixture, "vite.config.ts"));
  const prepared = spawnSync(join(app, "node_modules/.bin/tinker"), ["prepare"], {
    cwd: fixture,
    encoding: "utf8",
  });
  assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
  assert.deepEqual((await readdir(join(fixture, "src"))).sort(), [
    "contracts.ts",
    "lib",
    "notes.server.ts",
    "records.ts",
    "routes",
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
    "The base must compile with notes, without example feature files.",
  );
  console.log("PASS: installed base + note app + its own Register; tsc --noEmit EXIT 0.");
} finally {
  await rm(fixture, { recursive: true, force: true });
}
