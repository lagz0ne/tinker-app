import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** This package's folder: the base that runs this code. */
export const baseDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** @param {string} path - From a caller; why: read a JSON file once. */
export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** @param {string} path - From a check; why: a missing file reads as empty text. */
export function readText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/**
 * The 1-based line of a character offset, so a message can name file:line.
 * @param {string} text - From a read file; why: count the newlines before the offset.
 * @param {number} offset - From a parser or indexOf; why: a miss (-1) reads as line 1.
 */
export function lineAt(text, offset) {
  return offset < 0 ? 1 : text.slice(0, offset).split("\n").length;
}

/** This base's own package.json. */
export const basePackage = readJson(join(baseDir, "package.json"));

/** @param {string} path - From a file walk; why: pin or compare its bytes. */
export function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Where a package sits in the app's node_modules, walking up like Node; the link, not its target.
 * @param {string} root - From the app folder; why: start the walk up there.
 * @param {string} name - From a caller; why: the package to find.
 */
export function findPackage(root, name) {
  for (let dir = root; dir !== dirname(dir); dir = dirname(dir)) {
    const path = join(dir, "node_modules", name);
    if (existsSync(join(path, "package.json"))) return path;
  }
  return null;
}

/**
 * @param {string} root - From the app folder; why: start the walk up there.
 * @param {string} name - From a peer list; why: read its installed version.
 */
export function installedVersion(root, name) {
  const path = findPackage(root, name);
  return path && readJson(join(path, "package.json")).version;
}

/**
 * The base the app installs, as a real folder: found in the app's node_modules, walking up,
 * never through NODE_PATH, which a package manager's script run sets to its own store.
 * @param {string} root - From the app folder; why: find the base the app resolves.
 */
export function installedBase(root) {
  const path = findPackage(root, "@tinker/start");
  return path && realpathSync(path);
}

/**
 * Every file under a folder, as paths relative to `top`.
 * @param {string} dir - From a caller; why: the folder to walk.
 * @param {string} top - From a caller; why: make paths relative to it.
 */
export function listFiles(dir, top = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.name === "node_modules") return [];
    return entry.isDirectory() ? listFiles(path, top) : [relative(top, path)];
  });
}
