import { existsSync } from "node:fs";
import { join } from "node:path";

import { parseSource } from "./source.mjs";

/** Required command exports read by Start; the app owns its shell and styles. */
const namedFiles = [
  { option: "routerEntry", reads: "getRouter", required: true },
  { option: "startEntry", reads: "startInstance", required: true },
  { option: "serverEntry", reads: "default", required: true },
];

/** The app names all three native command entries in its own Vite config. */
function namedFile(root, entry) {
  const config = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"].find(
    (file) => existsSync(join(root, file)),
  );
  const file = config && entryPath(parseSource(join(root, config)).program, entry.option);
  return { ...entry, file };
}

export function serverFile(root) {
  return namedFile(
    root,
    namedFiles.find((entry) => entry.option === "serverEntry"),
  );
}

function entryPath(node, option) {
  if (node?.type === "Property" && (node.key.name ?? node.key.value) === option) {
    return typeof node.value.value === "string" ? node.value.value : undefined;
  }
  if (!node || typeof node !== "object") return undefined;
  return Object.values(node)
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map((value) => entryPath(value, option))
    .find(Boolean);
}

export function appFiles(root) {
  return namedFiles.map((entry) => namedFile(root, entry));
}

/** The page shell: when it exists, it replaces the base's root route. */
export const shellFile = "src/routes/__root.tsx";

/** Start's usual entry files, each with where its job went; the app names Start's entries. */
const startEntries = {
  router: "router options and client wiring go in cmds/router.ts",
  start: "global middleware and defaultSsr go in src/start.ts",
  server: "name the app server entry with serverEntry in vite.config.ts",
  client: "Start owns the client entry; client wiring goes in the configured router command",
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
