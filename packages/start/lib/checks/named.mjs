import { existsSync } from "node:fs";
import { join } from "node:path";

import { readComponentModules } from "../component-modules.mjs";
import { appFiles, ignoredFiles, serverFile } from "../named.mjs";
import { serverSource } from "../server-source.mjs";
import { mayExport } from "../source.mjs";
import { examples } from "./examples.mjs";
import { fail, verdict } from "./result.mjs";

export const say = {
  noEntry: 'vite.config.ts: name the server entry with tinker({ serverEntry: "cmds/server.ts" })',
  noServer: (root) =>
    `${serverFile(root).file} is missing; add this server entry:\n${serverSource}`,
  export: (file, name) => `${file}:1 does not export ${name}; the base imports it from this file`,
  ignored: (file, hint) => `${file}:1 is a Start file the base does not read; ${hint}`,
  noSeam: (file, part, names) =>
    `${file} is missing; the ${part} part reads ${names.join(" and ")} from it`,
  partExport: (file, name, part) => `${file}:1 does not export ${name}; the ${part} part reads it`,
  augment: (module, name, part) =>
    `src/ adds no ${name} bodies to "${module}"; the ${part} part reads them: declare module "${module}" { interface ${name} { … } }`,
  passed: (found) =>
    found.length > 0
      ? `each named or seam file exports what the base reads (${found.join(", ")}); no Start file is ignored`
      : "no named or seam files; the base defaults are in use",
};

/**
 * Check 5: each named or seam file the app has exports what the base imports from it, each on
 * part finds the seam names it reads and the app's augmentations, and no usual Start file sits
 * where the glue never reads it (ADR 0106). No fix.
 */
export function serverProblems(root) {
  if (!serverFile(root).file) return [say.noEntry];
  return existsSync(join(root, serverFile(root).file)) ? [] : [say.noServer(root)];
}

export function named(root) {
  if (!serverFile(root).file) return fail(serverProblems(root));

  const graph = readComponentModules(root);
  if (graph.problems.length > 0) return fail(graph.problems);

  const installed = examples(root);
  const found = appFiles(root).filter(({ file, reads }) => reads && existsSync(join(root, file)));
  const missing = found.flatMap(({ file, reads }) =>
    [reads]
      .flat()
      .filter((name) => !mayExport(join(root, file), name))
      .map((name) => say.export(file, name)),
  );
  const ignored = ignoredFiles
    .filter(
      ({ file }) =>
        existsSync(join(root, file)) && !appFiles(root).some((entry) => entry.file === file),
    )
    .map(({ file, hint }) => say.ignored(file, hint));
  return verdict(
    [
      ...serverProblems(root),
      ...appFiles(root)
        .filter(({ file, option }) => !option && !existsSync(join(root, file)))
        .map(({ file }) => `${file} is missing; copy the app entry`),
      ...missing,
      ...ignored,
      ...(installed.status === "fail" ? installed.lines : []),
    ],
    say.passed(found.map(({ file }) => file)),
  );
}
