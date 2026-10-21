import { join, relative } from "node:path";

import { physical, rootRoute } from "@tanstack/virtual-file-routes";

import { appFiles } from "./named.mjs";

/**
 * Vite aliases that join the app to the base: `@/` for the app, the copied `~/` files, the generated route tree, and the server entry when the app has one. A query such as `?url`
 * stays on the replaced path.
 * @param {string} root - From tinker(); why: the base reads app paths from there.
 */
export function aliases(root) {
  const server = appFiles(root).find((entry) => entry.option === "serverEntry")?.file;
  return [
    { find: /^~\//, replacement: `${join(root, "tinker")}/` },
    { find: /^@\//, replacement: `${join(root, "src")}/` },
    { find: /^#tinker\/routes$/, replacement: join(root, ".tinker/routeTree.gen.ts") },
    ...(server ? [{ find: /^#tinker\/server-main$/, replacement: join(root, server) }] : []),
  ];
}

/**
 * Start reads the app's named command entries and physical routes, relative to src/.
 * @param {string} root - From tinker(); why: Start takes paths relative to that app's src.
 */
export function startOptions(root) {
  const entries = appFiles(root);
  const missing = entries.find((entry) => !entry.file);
  if (missing) throw new Error(`vite.config.ts: name ${missing.option} in tinker()`);
  const file = (option) => entries.find((entry) => entry.option === option).file;

  const src = join(root, "src");
  const fromSrc = (file) => relative(src, join(root, file));

  return {
    srcDirectory: "src",
    start: { entry: fromSrc(file("startEntry")) },
    server: { entry: fromSrc(file("serverEntry")) },
    router: {
      entry: fromSrc(file("routerEntry")),
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
  const known = [
    "root",
    "serverEntry",
    "routerEntry",
    "startEntry",
    "workerEntry",
    "cliEntry",
    "compileHints",
    ...passed,
  ];
  const unknown = Object.keys(options).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    throw new Error(`tinker(): unknown option ${unknown.join(", ")}; known: ${known.join(", ")}`);
  }
  return Object.fromEntries(
    passed.filter((key) => key in options).map((key) => [key, options[key]]),
  );
}
