import { existsSync } from "node:fs";
import {
  join,
  basename,
  dirname,
  extname,
  matchesGlob,
  normalize,
  relative,
  resolve,
} from "node:path";

import { readJson } from "./paths.mjs";
import { parseSource, specifiers } from "./source.mjs";

/** Required command exports read by Start; the app owns its shell and styles. */
const namedFiles = [
  { option: "routerEntry", reads: "getRouter", required: true },
  { option: "startEntry", reads: "startInstance", required: true },
  { option: "serverEntry", reads: "default", required: true, role: "server" },
  { option: "workerEntry", reads: "default", required: false, role: "worker" },
  { option: "cliEntry", reads: "default", required: false, role: "cli" },
];

/** The app names all three native command entries in its own Vite config. */
function namedFile(root, entry) {
  const config = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"].find(
    (file) => existsSync(join(root, file)),
  );
  const file = config && entryPath(parseSource(join(root, config)).program, entry.option);
  const conventional = entry.role && `cmds/${entry.role}.ts`;
  return {
    ...entry,
    file,
    present: Boolean(file || (conventional && existsSync(join(root, conventional)))),
  };
}

/**
 * A CLI-only app names `cliEntry` and none of the three web entries in tinker(). It has no
 * routes, and needs no React or TanStack. An app that names any web entry stays a web app,
 * so a missing one is reported.
 * @param {string} root - From a check, prepare, or tinker(); why: the app to read.
 */
export function cliOnly(root) {
  const named = (entry) => Boolean(namedFile(root, entry).file);
  const cli = namedFiles.find((entry) => entry.option === "cliEntry");
  return named(cli) && !namedFiles.filter((entry) => entry.required).some(named);
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

/** The app's entries: the three web entries are required unless the app is CLI-only. */
export function appFiles(root) {
  const web = !cliOnly(root);
  return namedFiles
    .map((entry) => namedFile(root, entry))
    .filter((entry) => (entry.required && web) || entry.present);
}

/** Process entries share one host contract; optional entries keep their own SSR build config. */
export function commandFiles(root) {
  return appFiles(root)
    .filter((entry) => entry.role)
    .map((entry) => {
      if (entry.role === "server") return { ...entry, output: "dist/server/server.js" };

      const config = ["ts", "mts", "js", "mjs"]
        .map((extension) => `vite.${entry.role}.config.${extension}`)
        .find((file) => existsSync(join(root, file)));

      const program = config && parseSource(join(root, config)).program;
      const input = program && entryPath(program, "ssr");
      const outDir = program && entryPath(program, "outDir");

      return {
        ...entry,
        config,
        input,
        outDir,
        output:
          entry.file && outDir && join(outDir, basename(entry.file, extname(entry.file)) + ".js"),
      };
    });
}

/** Doctor and build use the same missing/configured process-entry checks. */
export function commandProblems(root) {
  return commandFiles(root)
    .filter((entry) => entry.role !== "server" && entry.file)
    .flatMap((entry) => {
      if (!entry.config) {
        return [
          `${entry.file}:1 needs vite.${entry.role}.config.ts with build.ssr and build.outDir`,
        ];
      }
      if (!entry.input || resolve(root, entry.input) !== resolve(root, entry.file)) {
        return [`${entry.config}:1 build.ssr must name ${entry.file}`];
      }
      if (!entry.outDir) return [`${entry.config}:1 name a literal build.outDir for ${entry.file}`];
      return [];
    });
}

/**
 * Each package.json bin runs the built CLI: its file exists, `files` lists it so a pack keeps
 * it, and it imports the entry the CLI build writes, read from vite.cli.config.ts. An app with no
 * bin has nothing to check; the exec bit is the package manager's job.
 * @param {string} root - From the named check; why: the app's package.json and bin files.
 */
export function binProblems(root) {
  const path = join(root, "package.json");
  const pkg = existsSync(path) ? readJson(path) : {};
  const bins = typeof pkg.bin === "string" ? { [pkg.name]: pkg.bin } : (pkg.bin ?? {});
  const cli = commandFiles(root).find((entry) => entry.role === "cli");

  /** @param {string} kept - From a bin; why: a file the pack must keep. No `files` keeps all. */
  const packed = (kept) =>
    !pkg.files ||
    pkg.files.some((entry) => {
      const pattern = normalize(entry).replace(/\/$/, "");
      return kept.startsWith(`${pattern}/`) || matchesGlob(kept, pattern);
    });
  return Object.entries(bins).flatMap(([name, named]) => {
    const file = normalize(named);
    if (!existsSync(join(root, file))) {
      return [`${file}:1 is missing; package.json bin ${name} names it`];
    }
    if (!packed(file)) {
      return [`package.json: files does not list ${file}, so a pack leaves out bin ${name}`];
    }

    if (!cli?.file) {
      return [`package.json: bin ${name} runs a built CLI; name cliEntry in tinker()`];
    }
    if (!cli.output) return [];
    const output = normalize(cli.output);
    if (!packed(output)) {
      return [
        `package.json: files does not list ${output}, so a pack leaves out the CLI bin ${name} imports`,
      ];
    }

    const built = resolve(root, output);
    const names = specifiers(parseSource(join(root, file))).map(({ name: spec }) => spec);
    if (names.some((spec) => resolve(root, dirname(file), spec) === built)) return [];
    const entry = relative(dirname(join(root, file)), built);
    return [`${file}:1 does not import ${entry}, the built CLI entry; import main from it`];
  });
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
