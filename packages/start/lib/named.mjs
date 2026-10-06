import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * App files the glue picks up, and nothing else (ADR 0106): the alias the base imports each by,
 * the export it reads, and the base default used while the file is absent.
 * Named files: router, start, server, style, and the shell (a route, so it has no alias).
 * Seam files: the two src/lib/tinker files.
 */
export const appFiles = [
  {
    file: "src/router.ts",
    alias: "#tinker/router",
    reads: "router",
    fallback: "src/defaults/router.ts",
  },
  {
    file: "src/start.ts",
    alias: "#tinker/start",
    reads: "startInstance",
    fallback: "src/defaults/start.ts",
  },
  {
    file: "src/server.ts",
    alias: "#tinker/server",
    reads: "default",
    fallback: "src/defaults/server.ts",
  },
  { file: "src/style.css", alias: "#tinker/style", fallback: "src/defaults/style.css" },
  {
    file: "src/lib/tinker.ts",
    alias: "#tinker/app",
    reads: "extensions",
    fallback: "src/defaults/app.ts",
  },
  {
    file: "src/lib/tinker.server.ts",
    alias: "#tinker/app.server",
    reads: "extensions",
    fallback: "src/defaults/app.server.ts",
  },
];

/** The page shell: when it exists, it replaces the base's root route. */
export const shellFile = "src/routes/__root.tsx";

/** Start's usual entry files, each with where its job went; the glue owns Start's entries. */
const startEntries = {
  router: "router options go in src/router.ts",
  start: "global middleware and defaultSsr go in src/start.ts",
  server: "a custom server entry goes in src/server.ts",
  client: "the base owns the client entry; client extensions go in src/lib/tinker.ts",
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
].filter(({ file }) => !appFiles.some((named) => named.file === file));

/**
 * The file the base reads for one entry: the app's own when it exists, else the base default.
 * @param {string} root - From the app folder; why: look for the app's file there.
 * @param {string} base - From a caller; why: the base folder the default lives in.
 * @param {{ file: string, fallback: string }} entry - From appFiles; why: which file to pick.
 */
export function pick(root, base, entry) {
  const own = join(root, entry.file);
  return existsSync(own) ? own : join(base, entry.fallback);
}
