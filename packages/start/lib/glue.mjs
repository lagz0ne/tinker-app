import { join, relative } from "node:path";

import { physical, rootRoute } from "@tanstack/virtual-file-routes";

import { serverFile } from "./named.mjs";

/**
 * Vite aliases that join the app to the base: `@/` for the app, the copied `~/` files, and the generated route tree. A query such as `?url`
 * stays on the replaced path.
 * @param {string} root - From tinker(); why: the base reads app paths from there.
 */
export function aliases(root) {
  return [
    { find: /^~\//, replacement: `${join(root, "tinker")}/` },
    { find: /^@\//, replacement: `${join(root, "src")}/` },
    { find: /^#tinker\/routes$/, replacement: join(root, ".tinker/routeTree.gen.ts") },
  ];
}

/**
 * Start's options: commands use copied base entries; routes still point into the package, relative to
 * src/ (Start resolves no package name or absolute path there). A part's routes mount only while
 * it is on, so an off part leaves its paths to the app.
 * @param {string} root - From tinker(); why: Start takes paths relative to that app's src.
 */
export function startOptions(root) {
  const server = serverFile(root).file;
  if (!server) {
    throw new Error(
      'vite.config.ts: name the server entry with tinker({ serverEntry: "cmds/server.ts" })',
    );
  }

  const src = join(root, "src");
  const fromSrc = (file) => relative(src, join(root, file));

  return {
    srcDirectory: "src",
    start: { entry: fromSrc("cmds/start.ts") },
    server: { entry: fromSrc(server) },
    router: {
      entry: fromSrc("cmds/router.ts"),
      generatedRouteTree: "../.tinker/routeTree.gen.ts",
      virtualRouteConfig: rootRoute("__root.tsx", [physical("", ".")]),
    },
    importProtection: {
      behavior: "error",
      client: {
        files: [/\.server\./, /\/backend\//],
        specifiers: ["@tanstack/react-start/server"],
      },
      server: { files: [/\.client\./] },
    },
  };
}

/** Start options the app may set; tinker() owns every other Start option. */
const passed = ["prerender", "pages", "spa", "sitemap"];

/**
 * The Start options tinker() passes on. An unknown key fails the build, so no option is dropped
 * in silence.
 * @param {Record<string, unknown>} options - From vite.config.ts; why: what the app asked for.
 */
export function passThrough(options) {
  const known = ["root", "serverEntry", "compileHints", ...passed];
  const unknown = Object.keys(options).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    throw new Error(`tinker(): unknown option ${unknown.join(", ")}; known: ${known.join(", ")}`);
  }
  return Object.fromEntries(
    passed.filter((key) => key in options).map((key) => [key, options[key]]),
  );
}
