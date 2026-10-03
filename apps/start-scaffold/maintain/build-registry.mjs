import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const app = resolve(import.meta.dirname, "..");
const root = resolve(app, "../..");
const pkg = JSON.parse(await readFile(join(app, "package.json"), "utf8"));
const workspace = await readFile(join(root, "pnpm-workspace.yaml"), "utf8");
const catalog = Object.fromEntries(
  [
    ...workspace
      .split("catalog:\n")
      .at(1)
      .split("\noverrides:")
      .at(0)
      .matchAll(/^  "?([^":]+)"?: (.+)$/gm),
  ].map(([, name, version]) => [name, version.replaceAll('"', "")]),
);
for (const dependencies of [pkg.dependencies, pkg.devDependencies]) {
  for (const [name, version] of Object.entries(dependencies)) {
    if (version.startsWith("npm:") && !version.slice(4).includes("@"))
      dependencies[name] = version.slice(4);
    if (version === "catalog:") dependencies[name] = catalog[name];
    if (version === "workspace:*") {
      dependencies[name] = JSON.parse(
        await readFile(join(root, "packages", name.split("/").at(1), "package.json"), "utf8"),
      ).version;
    }
    assert.ok(dependencies[name] && !dependencies[name].endsWith(":"), name);
  }
}
pkg.overrides = { vite: "$vite" };
for (const name of [
  "registry:build",
  "test:registry",
  "test:middleware",
  "test:imports",
  "test:seam:fixture",
])
  delete pkg.scripts[name];
pkg.scripts.check =
  "vp check && vp run typecheck && vp run test && vp run check:plain && vp run test:seam && vp run test:boundary && vp run test:schema";
await writeFile(join(app, "starter.package.json"), JSON.stringify(pkg, null, 2) + "\n");
const vp = join(root, "node_modules/.bin/vp");
for (const args of [
  ["dlx", "--", "shadcn@4.21.0", "build"],
  ["fmt", "public/r", "starter.package.json"],
]) {
  const result = spawnSync(vp, args, { cwd: app, stdio: "inherit" });
  assert.equal(result.status, 0);
}
