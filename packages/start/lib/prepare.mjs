import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readJsonc } from "./jsonc.mjs";
import { appFiles, cliOnly } from "./named.mjs";

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
 * What `.tinker/` must hold for this app and this tooling version.
 * Every path is absolute: shadcn reads `paths` with tsconfig-paths, which resolves an extended
 * file's paths from the app folder, so a relative "../src/*" sent its writes one folder up.
 * @param {string} root - From the app folder; why: aliases point at its files.
 */
export function render(root) {
  const paths = {
    "@/*": [`${join(root, "src")}/*`],
    "~/*": [`${join(root, "tinker")}/*`],
    "#tinker/routes": [join(root, ".tinker/routeTree.gen.ts")],
  };
  return {
    "tsconfig.json": json({
      compilerOptions: { ...compilerOptions, paths },
      include: [
        "../src",
        "../cmds",
        "../tinker",
        ...appFiles(root)
          .filter((entry) => entry.required && entry.file)
          .map((entry) => `../${entry.file}`),
        "../tests",
        "../vite.config.ts",
        "../vite.config.mts",
        ...(cliOnly(root) ? [] : ["./routeTree.gen.ts"]),
      ],
      exclude: ["../tests/runtime", "../dist", "../node_modules"],
    }),
  };
}

/**
 * An app whose tsconfig declares content mappers (Reylo `.sql`) reads each query's types from a
 * development database, so the app builds that file from its own migrations. It is generated,
 * beside `.tinker/`, before anything reads a query.
 * @param {string} root - From prepare; why: build that app's development database.
 */
function prepareDevDatabase(root) {
  const script = join(root, "maintain/sqlite-dev-db.mjs");
  const config = readJsonc(join(root, "tsconfig.json"));
  if (config.error !== undefined || config.value?.contentMappers === undefined) return;
  if (!existsSync(script)) return;

  execFileSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
}

/**
 * Write `.tinker/` and drop files an older base or app shape left there. A CLI-only app has no
 * route tree, so an old one from its web days goes too.
 * @param {string} root - From the plugin or the CLI; why: write `.tinker/` in that app.
 */
export function prepare(root) {
  const dir = join(root, ".tinker");
  mkdirSync(dir, { recursive: true });
  const old = ["base.json", "parts.ts", "parts.server.ts", "telemetry-env.ts"];
  for (const name of cliOnly(root) ? [...old, "routeTree.gen.ts"] : old) {
    rmSync(join(dir, name), { force: true });
  }

  const files = render(root);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);

  prepareDevDatabase(root);
  return Object.keys(files);
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
