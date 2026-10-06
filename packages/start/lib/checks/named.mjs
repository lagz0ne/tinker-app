import { existsSync } from "node:fs";
import { join } from "node:path";
import { appFiles, ignoredFiles } from "../named.mjs";
import { parts, recordedParts } from "../parts.mjs";
import { mayExport } from "../source.mjs";
import { verdict } from "./result.mjs";

export const say = {
  export: (file, name) => `${file}:1 does not export ${name}; the base imports it from this file`,
  ignored: (file, hint) => `${file}:1 is a Start file the base does not read; ${hint}`,
  noSeam: (file, part, names) =>
    `${file} is missing; the ${part} part reads ${names.join(" and ")} from it`,
  partExport: (file, name, part) => `${file}:1 does not export ${name}; the ${part} part reads it`,
  passed: (found) =>
    found.length > 0
      ? `each named or seam file exports what the base reads (${found.join(", ")}); no Start file is ignored`
      : "no named or seam files; the base defaults are in use",
};

/**
 * What each on part reads from a seam file: a missing file is named once per part, else each
 * name the file does not export. An `export *` from a package is not judged.
 * @param {string} root - From the named check; why: the app and its recorded parts.
 */
function partProblems(root) {
  return recordedParts(root).flatMap((part) =>
    Object.entries(parts[part].reads ?? {}).flatMap(([file, names]) => {
      if (!existsSync(join(root, file))) return [say.noSeam(file, part, names)];
      return names
        .filter((name) => !mayExport(join(root, file), name))
        .map((name) => say.partExport(file, name, part));
    }),
  );
}

/**
 * Check 5: each named or seam file the app has exports what the base imports from it, each on
 * part finds the seam names it reads, and no usual Start file sits where the glue never reads it
 * (ADR 0106). No fix.
 */
export function named(root) {
  const found = appFiles.filter(({ file, reads }) => reads && existsSync(join(root, file)));
  const missing = found
    .filter(({ file, reads }) => !mayExport(join(root, file), reads))
    .map(({ file, reads }) => say.export(file, reads));
  const ignored = ignoredFiles
    .filter(({ file }) => existsSync(join(root, file)))
    .map(({ file, hint }) => say.ignored(file, hint));
  return verdict(
    [...missing, ...partProblems(root), ...ignored],
    say.passed(found.map(({ file }) => file)),
  );
}
