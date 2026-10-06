import { join } from "node:path";
import { parseEnv } from "node:util";
import { readEnvFile } from "../env.mjs";
import { readPartEnv, rules } from "../part-env.mjs";
import { parts, recordedParts } from "../parts.mjs";
import { lineAt, readText } from "../paths.mjs";
import { verdict } from "./result.mjs";

export const say = {
  none: "no .env.example to check",
  missing: (line, key) => `.env.example:${line} lists ${key}; set it in .env or the shell`,
  refused: (at, key, part, wants) => `${at} sets ${key}; the ${part} part needs ${wants}`,
  unset: (key, part) => `.env does not set ${key}; the ${part} part needs it`,
  passed: (count) => `${count} key(s) from .env.example are set`,
  parts: (on) => `part keys read well: ${on.join(", ")}`,
};

/**
 * Each on part's keys, as the part reads them: the shell, then `.env`, then its default.
 * A value the part refuses is named at its `.env` line, or as the shell's. A key with no
 * default that is set nowhere is named once: by `.env.example` when it lists the key.
 * @param {string} root - From the env check; why: the app's record and `.env`.
 * @param {Record<string, string>} local - From the env check; why: the app's `.env`, parsed.
 * @param {string[]} listed - From the env check; why: the keys `.env.example` already names.
 */
function partProblems(root, local, listed) {
  const text = readText(join(root, ".env"));
  return recordedParts(root).flatMap((name) => {
    const keys = parts[name].env;
    return readPartEnv(keys, { ...local, ...process.env }).refused.flatMap((key) => {
      if (!process.env[key] && !local[key])
        return listed.includes(key) ? [] : [say.unset(key, name)];
      const at = process.env[key]
        ? "the shell"
        : `.env:${lineAt(text, text.search(new RegExp(`^${key}=`, "m")))}`;
      return [say.refused(at, key, name, rules[keys[key].rule].wants)];
    });
  });
}

/**
 * Check 9: each key `.env.example` lists is set in `.env` or the shell, and each on part's key
 * holds a value that part accepts. Lines follow `.env.example`, not parseEnv's sorted keys.
 * No fix: doctor never writes a secret.
 */
export function env(root) {
  const example = readText(join(root, ".env.example"));
  const local = readEnvFile(root);
  const keys = Object.keys(parseEnv(example));
  const missing = keys
    .filter((key) => !local[key] && !process.env[key])
    .map((key) => ({ key, line: lineAt(example, example.search(new RegExp(`^${key}=`, "m"))) }))
    .sort((a, b) => a.line - b.line)
    .map(({ key, line }) => say.missing(line, key));
  const on = recordedParts(root);
  const passed = [example ? say.passed(keys.length) : say.none];
  if (on.length > 0) passed.push(say.parts(on));
  return verdict([...missing, ...partProblems(root, local, keys)], passed.join("; "));
}
