import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { appFiles, pick } from "./named.mjs";
import { baseDir, basePackage, findPackage } from "./paths.mjs";

const compilerOptions = {
  target: "esnext",
  lib: ["es2024", "dom", "dom.iterable"],
  module: "esnext",
  moduleResolution: "bundler",
  types: ["node", "vite/client"],
  jsx: "react-jsx",
  strict: true,
  noUnusedLocals: true,
  noEmit: true,
  allowImportingTsExtensions: true,
  esModuleInterop: true,
  isolatedModules: true,
  verbatimModuleSyntax: true,
  skipLibCheck: true,
  resolveJsonModule: true,
};

/** @param {unknown} value - From render; why: one JSON style for every generated file. */
function json(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

/**
 * What `.tinker/` must hold for this app and this base version.
 * Every path is absolute: shadcn reads `paths` with tsconfig-paths, which resolves an extended
 * file's paths from the app folder, so a relative "../src/*" sent its writes one folder up.
 * @param {string} root - From the app folder; why: aliases point at its files.
 */
export function render(root) {
  const base = findPackage(root, "@tinker/start") ?? baseDir;
  const paths = {
    "@/*": [`${join(root, "src")}/*`],
    ...Object.fromEntries(appFiles.map((entry) => [entry.alias, [pick(root, base, entry)]])),
    "#tinker/routes": [join(root, ".tinker/routeTree.gen.ts")],
  };
  return {
    "tsconfig.json": json({
      compilerOptions: { ...compilerOptions, paths },
      include: [
        "../src",
        "../tests",
        "../vite.config.ts",
        "../vite.config.mts",
        "./routeTree.gen.ts",
      ],
      exclude: ["../dist", "../node_modules"],
    }),
    "base.json": json({ base: basePackage.version }),
  };
}

/** @param {string} root - From the plugin or the CLI; why: write `.tinker/` in that app. */
export function prepare(root) {
  const dir = join(root, ".tinker");
  mkdirSync(dir, { recursive: true });
  const files = render(root);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return Object.keys(files);
}

/**
 * Write `.tinker/routeTree.gen.ts` with no dev server and no build: resolving the app's own
 * Vite config runs Start's route generator once, so a fresh clone type-checks.
 * @param {string} root - From the CLI; why: load that app's vite.config.ts with its own Vite.
 */
export async function writeRouteTree(root) {
  const require = createRequire(join(root, "package.json"));
  const vite = await import(pathToFileURL(require.resolve("vite")).href);
  await vite.resolveConfig({ root, logLevel: "silent" }, "serve");
  return "routeTree.gen.ts";
}

/**
 * tinker prepare's exit code. A problem fails it, except as the postinstall script: a fresh
 * clone of a broken app must still install, so it can run doctor. The lines print either way,
 * and the build still stops on them.
 * @param {string[]} problems - From tinker prepare; why: what kept the route tree from being written.
 * @param {string | undefined} lifecycle - From npm_lifecycle_event; why: the script that runs prepare.
 */
export function prepareExitCode(problems, lifecycle) {
  return problems.length > 0 && lifecycle !== "postinstall" ? 1 : 0;
}
