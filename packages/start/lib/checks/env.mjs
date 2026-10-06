import { join } from "node:path";
import { parseEnv } from "node:util";
import { readEnvFile } from "../env.mjs";
import { lineAt, readText } from "../paths.mjs";
import { ok, verdict } from "./result.mjs";

export const say = {
  none: "no .env.example; no keys to check",
  missing: (line, key) => `.env.example:${line} lists ${key}; set it in .env or the shell`,
  passed: (count) => `${count} key(s) from .env.example are set`,
};

/**
 * Check 9: each key `.env.example` lists is set in `.env` or the shell.
 * No fix: doctor never writes a secret.
 */
export function env(root) {
  const example = readText(join(root, ".env.example"));
  if (!example) return ok(say.none);
  const local = readEnvFile(root);
  const keys = Object.keys(parseEnv(example));
  const missing = keys
    .filter((key) => !local[key] && !process.env[key])
    .map((key) => say.missing(lineAt(example, example.search(new RegExp(`^${key}=`, "m"))), key));
  return verdict(missing, say.passed(keys.length));
}
