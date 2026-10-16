import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { registryItems } from "../apps/start-scaffold/maintain/registry-source.mjs";
import { releaseUrls } from "../packages/start/lib/release.mjs";

/** Local assets only: the Start tarball, its manifest, and the registry it serves. No publish. */
const [version] = process.argv.slice(2);
const urls = releaseUrls(version);
const root = resolve(import.meta.dirname, "..");
const out = join(root, ".release", `start-v${version}`);
const assets = join(out, "assets");
const registryPath = "apps/start-scaffold/public/r";
const scratch = await mkdtemp(join(tmpdir(), "tinker-release-"));
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: "inherit" });

try {
  await rm(out, { recursive: true, force: true });
  await mkdir(assets, { recursive: true });
  run("vp", ["run", "-r", "build"]);

  const source = join(root, "packages/start");
  const current = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  assert.equal(current.version, version, `packages/start is ${current.version}, not ${version}`);
  run(process.execPath, [join(source, "scripts/pack.mjs"), scratch]);

  const file = `tinker-start-${version}.tgz`;
  const target = join(assets, file);
  await copyFile(join(scratch, file), target);

  // The packed manifest must name only real specs: no workspace or catalog leftovers.
  run("tar", ["-xzf", target, "-C", scratch, "package/package.json"]);
  const packed = JSON.parse(await readFile(join(scratch, "package/package.json"), "utf8"));
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const [name, spec] of Object.entries(packed[field] ?? {})) {
      assert.ok(!/^(workspace|catalog):/.test(spec), `${file}: ${field} ${name} is ${spec}`);
      if (name in urls && field !== "peerDependencies") assert.equal(spec, urls[name], name);
    }
  }

  const size = (await stat(target)).size;
  const sha256 = createHash("sha256")
    .update(await readFile(target))
    .digest("hex");
  const manifest = {
    version,
    tag: `start-v${version}`,
    repo: "lagz0ne/tinker-app",
    assets: [{ file, size, sha256, url: urls["@tinker/start"] }],
    uses: { "@tinker/core": urls["@tinker/core"], "@tinker/react": urls["@tinker/react"] },
  };
  console.log(`ASSET ${file} ${size} bytes sha256 ${sha256}`);

  const { registry, items, packages } = await registryItems({ version });
  const registryOut = join(out, registryPath);
  await mkdir(registryOut, { recursive: true });
  for (const item of items) {
    await writeFile(join(registryOut, `${item.name}.json`), JSON.stringify(item, null, 2) + "\n");
  }
  await writeFile(
    join(registryOut, "registry.json"),
    JSON.stringify({ ...registry, items }, null, 2) + "\n",
  );
  for (const [path, pkg] of Object.entries(packages)) {
    await writeFile(join(out, "apps/start-scaffold", path), JSON.stringify(pkg, null, 2) + "\n");
  }
  await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  console.log(`RELEASE ${out}: ${items.length} registry items; nothing published.`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
