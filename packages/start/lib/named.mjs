import { existsSync } from "node:fs";
import { join } from "node:path";

import { parseSource } from "./source.mjs";

/**
 * App files the glue picks up, and nothing else (ADR 0106): the alias the base imports each by,
 * the exports it reads, and any base default used while the file is absent.
 * Named files: router, start, server, style, and the shell (a route, so it has no alias).
 * Item wiring is plain code in the app entries (ADR 0118).
 */
const namedFiles = [
  { file: "cmds/router.ts", reads: "getRouter", required: true },
  { file: "cmds/start.ts", reads: "startInstance", required: true },
  { option: "serverEntry", reads: "default", required: true },
];

/** The app names its server entry in its own Vite config. */
export function serverFile(root) {
  const config = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"].find(
    (file) => existsSync(join(root, file)),
  );
  const file = config && entryPath(parseSource(join(root, config)).program);
  return { ...namedFiles.find((entry) => entry.option === "serverEntry"), file };
}

function entryPath(node) {
  if (node?.type === "Property" && (node.key.name ?? node.key.value) === "serverEntry") {
    return typeof node.value.value === "string" ? node.value.value : undefined;
  }
  if (!node || typeof node !== "object") return undefined;
  return Object.values(node)
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map(entryPath)
    .find(Boolean);
}

export function appFiles(root) {
  return namedFiles.map((entry) => (entry.option === "serverEntry" ? serverFile(root) : entry));
}

/** The page shell: when it exists, it replaces the base's root route. */
export const shellFile = "src/routes/__root.tsx";

/** Start's usual entry files, each with where its job went; the glue owns Start's entries. */
const startEntries = {
  router: "router options and client wiring go in cmds/router.ts",
  start: "global middleware and defaultSsr go in src/start.ts",
  server: "name the app server entry with serverEntry in vite.config.ts",
  client: "the base owns the client entry; client wiring goes in cmds/router.ts",
};

/** Start files the glue never reads: each one fails the build, so none is ignored in silence. */
export const ignoredFiles = [
  ...Object.entries(startEntries).flatMap(([name, hint]) =>
    [".ts", ".tsx", ".js", ".jsx"].map((ext) => ({ file: `src/${name}${ext}`, hint })),
  ),
  {
    file: "src/routeTree.gen.ts",
    hint: "the route tree is .tinker/routeTree.gen.ts; delete this file",
  },
].filter(({ file }) => file !== "src/start.ts" && !namedFiles.some((named) => named.file === file));
