import { join } from "node:path";
import { basePackage, readJson } from "./paths.mjs";

/** The base's parts (ADR 0106), from its package.json: each one's default, routes, and env keys. */
export const parts = basePackage.tinker.parts;

/**
 * The parts tinker() turns on, in the base's order: each part's own option, else (unset or
 * undefined, as the option's type allows) its default.
 * A part option that is not true or false fails the build, so no switch is misread.
 * @param {Record<string, unknown>} options - From tinker(); why: the app's part switches.
 */
export function partsOn(options) {
  return Object.entries(parts)
    .filter(([name, part]) => {
      const value = options[name] ?? part.on;
      if (typeof value !== "boolean") throw new Error(`tinker(): ${name} takes true or false`);
      return value;
    })
    .map(([name]) => name);
}

/**
 * The parts the app's last tinker() call turned on, as `.tinker/base.json` records them; the
 * defaults while the record is missing or unreadable (check 3 names it stale). A part this base
 * does not have is left out. Doctor and `tinker prepare` read the build's own switches.
 * @param {string} root - From prepare, doctor, or a check; why: the app whose record to read.
 */
export function recordedParts(root) {
  try {
    const recorded = readJson(join(root, ".tinker/base.json")).parts ?? partsOn({});
    return recorded.filter((name) => name in parts);
  } catch {
    return partsOn({});
  }
}
