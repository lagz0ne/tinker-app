import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { installedBase, listFiles, readJson, sha256 } from "../paths.mjs";
import { fail, skip, verdict } from "./result.mjs";

export const say = {
  missing: "@tinker/start does not resolve",
  link: (path) => `workspace link to ${path}; a source checkout has no pinned bytes`,
  noPins: "files.json is missing from the base",
  edited: (file, kind) =>
    `node_modules/@tinker/start/${file} ${kind}; an install drops base edits, so use an extension point`,
  passed: (count) => `${count} files match files.json`,
  reinstall: (spec) => `reinstall @tinker/start (${spec}) with your package manager`,
  restored: (count, tarball) => `restored ${count} file(s) from ${tarball}`,
};

/**
 * @param {string} dir - From the installed base; why: hash what is on disk.
 * @param {Record<string, string>} pinned - From files.json; why: the released bytes.
 */
function changedFiles(dir, pinned) {
  const own = new Set(["files.json", "package.json"]);
  const changed = Object.entries(pinned)
    .filter(([file, hash]) => !existsSync(join(dir, file)) || sha256(join(dir, file)) !== hash)
    .map(([file]) => ({ file, kind: existsSync(join(dir, file)) ? "changed" : "missing" }));
  const added = listFiles(dir)
    .filter((file) => !own.has(file) && !(file in pinned))
    .map((file) => ({ file, kind: "added" }));
  return [...changed, ...added];
}

/**
 * Put the released bytes back from the tarball the app depends on.
 * @param {string} root - From the CLI; why: read the app's dependency spec.
 * @param {string} dir - From the installed base; why: the folder to repair.
 * @param {{ file: string, kind: string }[]} changed - From changedFiles; why: what to repair.
 */
function restoreBase(root, dir, changed) {
  const spec = readJson(join(root, "package.json")).dependencies["@tinker/start"];
  if (!/^file:.*\.tgz$/.test(spec)) return say.reinstall(spec);
  const unpacked = mkdtempSync(join(tmpdir(), "tinker-restore-"));
  execFileSync("tar", ["-xzf", resolve(root, spec.slice(5)), "-C", unpacked]);
  for (const { file, kind } of changed) {
    if (kind === "added") rmSync(join(dir, file));
    else writeFileSync(join(dir, file), readFileSync(join(unpacked, "package", file)));
  }
  rmSync(unpacked, { recursive: true, force: true });
  return say.restored(changed.length, spec.slice(5).split("/").at(-1));
}

/** Check 2: every installed base file matches the hashes the release pinned in files.json. */
export function bytes(root) {
  const dir = installedBase(root);
  if (!dir) return fail([say.missing]);
  if (!dir.split(sep).includes("node_modules")) return skip(say.link(relative(root, dir)));
  if (!existsSync(join(dir, "files.json"))) return fail([say.noPins]);
  const pinned = readJson(join(dir, "files.json"));
  const changed = changedFiles(dir, pinned);
  return verdict(
    changed.map(({ file, kind }) => say.edited(file, kind)),
    say.passed(Object.keys(pinned).length),
    () => restoreBase(root, dir, changed),
  );
}
