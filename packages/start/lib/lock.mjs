import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as fsp from "node:fs/promises";
import { dirname, join } from "node:path";

/** The lock file's app-relative path. */
export const lockPath = "tinker/components.lock";

/** @param {string} a - From a sort; why: keep the order stable. @param {string} b - From a sort. */
function byText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Deep-sorted JSON: every object's keys in order, so the lock text never depends on write order.
 * @param {unknown} value - From lockText; why: the lock as it will be written.
 */
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(byText)
      .map((key) => [key, sorted(value[key])]),
  );
}

/**
 * The lock as the file holds it: sorted keys, 2 spaces, one trailing newline.
 * @param {object} lock - From writeLock; why: the lock to serialize.
 */
export function lockText(lock) {
  return `${JSON.stringify(sorted(lock), null, 2)}\n`;
}

/**
 * The sha256 hex of one file's bytes.
 * @param {string} path - From entryOf; why: the file to hash.
 */
export async function hashFile(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

/**
 * One lock entry: every path hashed, plus the start version that wrote it.
 * @param {string} root - From a command; why: the app the paths are relative to.
 * @param {string[]} paths - From a command; why: the app-relative files the component owns.
 * @param {string} start - From a command; why: the `@tinker/start` version that copied them.
 */
export async function entryOf(root, paths, start) {
  const files = {};
  for (const path of [...paths].sort(byText)) files[path] = await hashFile(join(root, path));
  return { files, start };
}

/**
 * The lock this app holds. An absent file is an empty lock.
 * @param {string} root - From a command; why: the app holding `tinker/components.lock`.
 */
export async function readLock(root) {
  const path = join(root, lockPath);
  if (!existsSync(path)) return { components: {}, version: 1 };

  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return { components: parsed?.components ?? {}, version: parsed?.version ?? 1 };
  } catch (error) {
    throw new Error(`${lockPath}: ${error.message}`);
  }
}

/**
 * Write the lock through `tinker/components.lock.tinker-new`, then rename it over the lock, so a
 * failure leaves the old lock whole.
 * @param {string} root - From a command; why: the app to write in.
 * @param {object} lock - From a command; why: the whole lock.
 * @param {object} [ops] - From a command; why: the fs ops a test can fail on purpose.
 */
export async function writeLock(root, lock, ops = fsp) {
  const path = join(root, lockPath);
  const temp = `${path}.tinker-new`;
  await ops.mkdir(dirname(path), { recursive: true });
  try {
    await ops.writeFile(temp, lockText(lock));
    await ops.rename(temp, path);
  } catch (error) {
    await ops.rm(temp, { force: true }).catch(() => null);
    throw error;
  }
}
