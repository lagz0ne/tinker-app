import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appFiles, pick } from "./named.mjs";
import { partNotes, parts, recordedParts } from "./parts.mjs";
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
 * A parts file: one export per part the entry reads, from that part's on module or its off
 * module in the base. The base entries import it as `#tinker/parts` (the router) or
 * `#tinker/parts.server` (the server).
 * @param {string} base - From render; why: the base folder the modules live in.
 * @param {string[]} on - From render; why: the parts that are on.
 * @param {"router" | "server"} entry - From render; why: the entry that imports the file.
 */
function partsFile(base, on, entry) {
  const lines = Object.entries(parts)
    .filter(([, part]) => entry in part.entries)
    .map(([name, part]) => {
      const module = on.includes(name) ? part.entries[entry] : "off.ts";
      return `export { ${name} } from ${JSON.stringify(join(base, "src/parts", name, module))};`;
    });
  const notes = partNotes(on)
    .map((note) => `; ${note}`)
    .join("");
  return `// Written by tinker(); parts on: ${on.join(", ") || "none"}${notes}.\n${lines.join("\n")}\n`;
}

/**
 * What `.tinker/` must hold for this app, this base version, and these parts.
 * Every path is absolute: shadcn reads `paths` with tsconfig-paths, which resolves an extended
 * file's paths from the app folder, so a relative "../src/*" sent its writes one folder up.
 * @param {string} root - From the app folder; why: aliases point at its files.
 * @param {string[]} on - From tinker()'s options, else the record; why: the parts to write.
 */
export function render(root, on = recordedParts(root)) {
  const base = findPackage(root, "@tinker/start") ?? baseDir;
  const paths = {
    "@/*": [`${join(root, "src")}/*`],
    ...Object.fromEntries(appFiles.map((entry) => [entry.alias, [pick(root, base, entry)]])),
    "#tinker/routes": [join(root, ".tinker/routeTree.gen.ts")],
    "#tinker/parts": [join(root, ".tinker/parts.ts")],
    "#tinker/parts.server": [join(root, ".tinker/parts.server.ts")],
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
    "base.json": json({ base: basePackage.version, parts: on }),
    "parts.ts": partsFile(base, on, "router"),
    "parts.server.ts": partsFile(base, on, "server"),
  };
}

/**
 * @param {string} root - From the plugin or the CLI; why: write `.tinker/` in that app.
 * @param {string[]} [on] - From tinker()'s options; why: the CLI keeps the recorded parts.
 */
export function prepare(root, on) {
  const dir = join(root, ".tinker");
  mkdirSync(dir, { recursive: true });
  const files = render(root, on);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
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
