import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { listFiles, readJson, sha256 } from "../lib/paths.mjs";

/** Pack this base as a release: files.json pins every shipped file's bytes. */
const dir = resolve(import.meta.dirname, "..");
const out = resolve(process.argv[2] ?? join(dir, "packs"));
const pkg = readJson(join(dir, "package.json"));
const shipped = pkg.files
  .flatMap((entry) => (entry.includes(".") ? [entry] : listFiles(join(dir, entry), dir)))
  .filter((file) => file !== "files.json")
  .sort();
writeFileSync(
  join(dir, "files.json"),
  JSON.stringify(
    Object.fromEntries(shipped.map((file) => [file, sha256(join(dir, file))])),
    null,
    2,
  ) + "\n",
);
mkdirSync(out, { recursive: true });
try {
  execFileSync("pnpm", ["pack", "--pack-destination", out], { cwd: dir, stdio: "inherit" });
} finally {
  rmSync(join(dir, "files.json"));
}
console.log(`packed @tinker/start ${pkg.version}: ${shipped.length} files pinned in files.json`);
