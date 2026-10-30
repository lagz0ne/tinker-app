import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { basePackage } from "./paths.mjs";

/** ADR 0106: the registry of the release tag this app installed. */
export function defaultRegistryBase() {
  return `https://raw.githubusercontent.com/lagz0ne/tinker-app/start-v${basePackage.version}/apps/start-scaffold/public/r`;
}

/** @param {string} text - From a flag; why: a URL reads over http, a path over node:fs. */
function isUrl(text) {
  return /^https?:\/\//.test(text);
}

/**
 * Where this run reads the registry from.
 * @param {string} root - From the command; why: a relative path resolves from the app folder.
 * @param {string} [flag] - From `--registry`; why: a folder, a registry.json file, or a URL.
 */
export function registryBase(root, flag) {
  if (flag === undefined) return defaultRegistryBase();
  if (isUrl(flag)) return flag.replace(/\/+$/, "");

  const path = resolve(root, flag);
  if (existsSync(path) && statSync(path).isDirectory()) return path;
  return path.endsWith(".json") ? dirname(path) : path;
}

/**
 * One JSON file from the registry, by name, without its base.
 * @param {string} base - From registryBase; why: the folder or URL holding the files.
 * @param {string} name - From a caller; why: `registry.json` or `<component>.json`.
 */
export async function readRegistryJson(base, name) {
  if (isUrl(base)) {
    const response = await fetch(`${base}/${name}`);
    if (!response.ok) throw new Error(`registry ${base}: ${response.status} for ${name}`);
    return response.json();
  }

  try {
    return JSON.parse(readFileSync(join(base, name), "utf8"));
  } catch (error) {
    throw new Error(`registry ${base}: ${error.message}`);
  }
}
