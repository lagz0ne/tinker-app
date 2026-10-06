import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { physical, rootRoute, route } from "@tanstack/virtual-file-routes";
import { appFiles, pick, shellFile } from "./named.mjs";
import { baseDir, basePackage } from "./paths.mjs";

/**
 * Vite aliases that join the app to the base: `@/` for the app, and one `#tinker/*` name per
 * named or seam file. A query such as `?url` stays on the replaced path.
 * @param {string} root - From tinker(); why: the base reads app paths from there.
 */
export function aliases(root) {
  return [
    { find: /^@\//, replacement: `${join(root, "src")}/` },
    ...appFiles.map((entry) => ({
      find: new RegExp(`^${entry.alias.replaceAll(".", "\\.")}(\\?.*)?$`),
      replacement: `${pick(root, baseDir, entry)}$1`,
    })),
    { find: /^#tinker\/routes$/, replacement: join(root, ".tinker/routeTree.gen.ts") },
  ];
}

/**
 * Start's options: entries and base routes point into the base, by paths relative to the app's
 * src/ (Start resolves no package name or absolute path there).
 * @param {string} root - From tinker(); why: Start takes paths relative to that app's src.
 */
export function startOptions(root) {
  const src = join(root, "src");
  const routes = join(src, "routes");
  const fromSrc = (file) => relative(src, join(baseDir, "src", file));
  const fromRoutes = (file) => relative(routes, join(baseDir, file));
  const shell = existsSync(join(root, shellFile))
    ? "__root.tsx"
    : fromRoutes("src/routes/root.tsx");
  const mounted = Object.entries(basePackage.tinker.routes).map(([path, file]) =>
    route(path, fromRoutes(file)),
  );
  return {
    srcDirectory: "src",
    start: { entry: fromSrc("entry/start.ts") },
    server: { entry: fromSrc("entry/server.ts") },
    router: {
      entry: fromSrc("entry/router.tsx"),
      generatedRouteTree: "../.tinker/routeTree.gen.ts",
      virtualRouteConfig: rootRoute(shell, [...mounted, physical("", ".")]),
    },
    importProtection: {
      behavior: "error",
      client: {
        files: [/\.server\./, /\/backend\//],
        specifiers: ["@tanstack/react-start/server", "@tinker/start/server"],
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
  const known = ["root", ...passed];
  const unknown = Object.keys(options).filter((key) => !known.includes(key));
  if (unknown.length > 0)
    throw new Error(`tinker(): unknown option ${unknown.join(", ")}; known: ${known.join(", ")}`);
  return Object.fromEntries(
    passed.filter((key) => key in options).map((key) => [key, options[key]]),
  );
}
