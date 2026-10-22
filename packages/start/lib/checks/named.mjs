import { existsSync } from "node:fs";
import { join } from "node:path";

import { readComponentModules } from "../component-modules.mjs";
import {
  appFiles,
  binProblems,
  cliOnly,
  ignoredFiles,
  serverFile,
  commandProblems,
} from "../named.mjs";
import { serverSource } from "../server-source.mjs";
import { mayExport } from "../source.mjs";
import { fail, verdict } from "./result.mjs";

export const say = {
  noEntry:
    'vite.config.ts: name the server entry with tinker({ serverEntry: "cmds/server.ts", routerEntry: "cmds/router.ts", startEntry: "cmds/start.ts" })',
  noServer: (root) =>
    `${serverFile(root).file} is missing; add this server entry:\n${serverSource}`,
  export: (file, name) => `${file}:1 does not export ${name}; the base imports it from this file`,
  ignored: (file, hint) => `${file}:1 is a Start file the base does not read; ${hint}`,
  passed: (found) =>
    found.length > 0
      ? `each named or seam file exports what the base reads (${found.join(", ")}); no Start file is ignored`
      : "no configured command entries found",
};

/** Check each configured command export, copied dependency graph and ignored Start file. */
export function serverProblems(root) {
  if (!serverFile(root).file && !cliOnly(root)) return [say.noEntry];
  return [
    ...appFiles(root).flatMap(({ file, option }) => {
      if (!file) return [`vite.config.ts: name ${option} in tinker()`];
      if (existsSync(join(root, file))) return [];
      return option === "serverEntry"
        ? [say.noServer(root)]
        : [`${file} is missing; copy the app entry`];
    }),
    ...commandProblems(root),
  ];
}

export function named(root) {
  if (!serverFile(root).file && !cliOnly(root)) return fail(serverProblems(root));

  const graph = readComponentModules(root);
  if (graph.problems.length > 0) return fail(graph.problems);

  const found = appFiles(root).filter(
    ({ file, reads }) => file && reads && existsSync(join(root, file)),
  );
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
    [...serverProblems(root), ...missing, ...ignored, ...binProblems(root)],
    say.passed(found.map(({ file }) => file)),
  );
}
