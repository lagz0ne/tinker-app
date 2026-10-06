import { join } from "node:path";
import { lineOfKey, readJsonc } from "../jsonc.mjs";
import { installedBase, installedVersion, readJson } from "../paths.mjs";
import { fail, verdict } from "./result.mjs";

export const say = {
  missing: "package.json:1 does not install @tinker/start; add it and install",
  drift: (at, name, found, tested) =>
    `${at} ${name} is ${found ?? "missing"}, tested with ${tested}`,
  stale: (at, name, spec, found) =>
    `${at} pins ${name} ${spec}, but ${found ?? "nothing"} is installed; run install`,
  passed: (version, count) => `@tinker/start ${version}; ${count} peers match the tested versions`,
};

/** A spec that names one exact version, such as 1.168.60; ranges and protocols are skipped. */
const exact = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

/**
 * Where package.json names a package, as `package.json:<line>`.
 * @param {{ text: string, value: Record<string, any> }} pkg - From readJsonc; why: the app's package.json.
 * @param {string} name - From a check; why: the package to find.
 */
function where(pkg, name) {
  const field = ["dependencies", "devDependencies"].find((key) => pkg.value[key]?.[name]);
  return `package.json:${field ? lineOfKey(pkg.text, [field, name]) : 1}`;
}

/**
 * Each exact pin package.json declares that the install does not match: the file changed and
 * nobody ran install, so the app runs other bytes than it says.
 * @param {string} root - From the version check; why: the app's node_modules.
 * @param {{ text: string, value: Record<string, any> }} pkg - From readJsonc; why: the declared pins.
 */
function stalePins(root, pkg) {
  const declared = { ...pkg.value.dependencies, ...pkg.value.devDependencies };
  return Object.entries(declared)
    .filter(([, spec]) => exact.test(spec))
    .map(([name, spec]) => [name, spec, installedVersion(root, name)])
    .filter(([, spec, found]) => found !== spec)
    .map(([name, spec, found]) => say.stale(where(pkg, name), name, spec, found));
}

/**
 * Check 1: the base resolves, its peers are the versions it was tested with, and every exact
 * pin in package.json is what is installed.
 */
export function version(root) {
  const dir = installedBase(root);
  if (!dir) return fail([say.missing]);
  const base = readJson(join(dir, "package.json"));
  const read = readJsonc(join(root, "package.json"), { strict: true });
  const pkg = read.error ? { text: "", value: {} } : read;
  const tested = Object.entries(base.tinker.tested);
  const drift = tested
    .map(([name, want]) => [name, installedVersion(root, name), want])
    .filter(([, found, want]) => found !== want)
    .map(([name, found, want]) => say.drift(where(pkg, name), name, found, want));
  return verdict([...stalePins(root, pkg), ...drift], say.passed(base.version, tested.length));
}
