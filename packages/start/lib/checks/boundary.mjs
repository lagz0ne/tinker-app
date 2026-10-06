import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJson } from "../paths.mjs";
import { skip, verdict } from "./result.mjs";

export const say = {
  none: "no build has run yet; vp build checks import boundaries",
  found: ({ importer, specifier, env, rule }) =>
    `${importer} imports "${specifier}" into ${env} code (${rule}); call it through createServerFn, or import it only from server code`,
  passed: "the last build had no import boundary violations",
};

/**
 * Check 10: every import boundary violation the last build or dev run kept in
 * `.tinker/violations.json`; Start's own error stops at the first one. No fix.
 */
export function boundary(root) {
  const path = join(root, ".tinker/violations.json");
  if (!existsSync(path)) return skip(say.none);
  return verdict(readJson(path).map(say.found), say.passed);
}
