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
 * What is wrong with an item's `meta.toolchain`, or null when it is absent or well shaped:
 * an object from an app file path to the lines the user pastes into that file.
 * @param {unknown} toolchain - From an item's `meta`; why: the field to check before printing it.
 */
export function toolchainProblem(toolchain) {
  if (toolchain === undefined) return null;
  if (toolchain === null || typeof toolchain !== "object" || Array.isArray(toolchain)) {
    return "it must be an object of file -> lines";
  }

  for (const [file, lines] of Object.entries(toolchain)) {
    const problem = toolchainEntryProblem(file, lines);
    if (problem !== null) return problem;
  }
  return null;
}

/** Keys an object may not take from a registry: they name the prototype, not a file. */
const prototypeKeys = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Whether a line holds a control character: a carriage return or an escape sequence can redraw
 * the terminal, so a printed line could hide or fake the lines around it.
 * @param {string} line - From toolchainEntryProblem; why: one line the user would paste.
 */
function hasControl(line) {
  for (let index = 0; index < line.length; index += 1) {
    const code = line.charCodeAt(index);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * What is wrong with one `meta.toolchain` entry, or null: a relative app file with no `.` or `..`
 * segment, then one or more one-line strings with no control characters.
 * @param {string} file - From toolchainProblem; why: the key, where the lines go.
 * @param {unknown} lines - From toolchainProblem; why: the value, what the user pastes.
 */
function toolchainEntryProblem(file, lines) {
  const segments = file.split("/");
  const dots = segments.some((segment) => segment === "." || segment === "..");
  if (!/^[\w.-]+(\/[\w.-]+)*$/.test(file) || dots || prototypeKeys.has(file)) {
    return `bad file ${JSON.stringify(file)}`;
  }

  const text = (line) => typeof line === "string" && line.trim() !== "" && !hasControl(line);
  if (!Array.isArray(lines) || lines.length === 0 || !lines.every(text)) {
    return `${file} must be a list of one-line strings with no control characters`;
  }
  return null;
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
