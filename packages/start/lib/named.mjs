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
  {
    file: "cmds/router.ts",
    alias: "#tinker/router",
    reads: ["router", "extensions"],
    fallback: "src/defaults/router.ts",
  },
  {
    file: "src/start.ts",
    alias: "#tinker/start",
    reads: "startInstance",
    fallback: "src/defaults/start.ts",
  },
  {
    option: "serverEntry",
    alias: "#tinker/server",
    reads: "default",
    required: true,
  },
  { file: "src/style.css", alias: "#tinker/style", fallback: "src/defaults/style.css" },
];

/** The app names its server entry in its own Vite config. */
export function serverFile(root) {
  const config = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"].find(
    (file) => existsSync(join(root, file)),
  );
  const file = config && entryPath(parseSource(join(root, config)).program);
  return { ...namedFiles.find((entry) => entry.alias === "#tinker/server"), file };
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
  return namedFiles.map((entry) => (entry.alias === "#tinker/server" ? serverFile(root) : entry));
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
].filter(({ file }) => !namedFiles.some((named) => named.file === file));

/**
 * The file the base reads for one entry: the app's own when it exists, else the base default.
 * @param {string} root - From the app folder; why: look for the app's file there.
 * @param {string} base - From a caller; why: the base folder the default lives in.
 * @param {{ file: string, fallback?: string }} entry - From appFiles; why: which file to pick.
 */
export function pick(root, base, entry) {
  if (!entry.file) {
    throw new Error(
      'vite.config.ts: name the server entry with tinker({ serverEntry: "cmds/server.ts" })',
    );
  }
  const own = join(root, entry.file);
  return existsSync(own) || !entry.fallback ? own : join(base, entry.fallback);
}
