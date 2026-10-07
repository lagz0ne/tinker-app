import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { app, registryItems } from "./registry-source.mjs";

const out = resolve(process.env.TINKER_REGISTRY_OUT ?? join(app, "public/r"));
const { registry, items, packages } = await registryItems({
  packs: process.env.TINKER_PACKAGE_DIR,
  url: process.env.TINKER_REGISTRY_URL,
});
await mkdir(out, { recursive: true });
for (const item of items)
  await writeFile(join(out, `${item.name}.json`), JSON.stringify(item, null, 2) + "\n");
await writeFile(join(out, "registry.json"), JSON.stringify({ ...registry, items }, null, 2) + "\n");
if (!process.env.TINKER_REGISTRY_OUT) {
  for (const [path, pkg] of Object.entries(packages))
    await writeFile(join(app, path), JSON.stringify(pkg, null, 2) + "\n");
}
const formatted = spawnSync(
  "vp",
  ["fmt", out, ...(!process.env.TINKER_REGISTRY_OUT ? Object.keys(packages) : [])],
  { cwd: app, stdio: "inherit" },
);
assert.equal(formatted.status, 0);
console.log(`Built ${items.length} local registry items from source; no publish.`);
