import { existsSync } from "node:fs";
import { join } from "node:path";
import { appFiles, ignoredFiles } from "../named.mjs";
import { mayExport } from "../source.mjs";
import { verdict } from "./result.mjs";

export const say = {
  export: (file, name) => `${file}:1 does not export ${name}; the base imports it from this file`,
  ignored: (file, hint) => `${file}:1 is a Start file the base does not read; ${hint}`,
  passed: (found) =>
    found.length > 0
      ? `each named or seam file exports what the base reads (${found.join(", ")}); no Start file is ignored`
      : "no named or seam files; the base defaults are in use",
};

/**
 * Check 5: each named or seam file the app has exports what the base imports from it,
 * and no usual Start file sits where the glue never reads it (ADR 0106). No fix.
 */
export function named(root) {
  const found = appFiles.filter(({ file, reads }) => reads && existsSync(join(root, file)));
  const missing = found
    .filter(({ file, reads }) => !mayExport(join(root, file), reads))
    .map(({ file, reads }) => say.export(file, reads));
  const ignored = ignoredFiles
    .filter(({ file }) => existsSync(join(root, file)))
    .map(({ file, hint }) => say.ignored(file, hint));
  return verdict([...missing, ...ignored], say.passed(found.map(({ file }) => file)));
}
