import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { clientOutput, serverOutput } from "./lib/build-output.mjs";
import { say as routeSay } from "./lib/checks/routes.mjs";
import { buildChecks } from "./lib/doctor.mjs";
import { aliases, passThrough, startOptions } from "./lib/glue.mjs";
import { recordViolation, restartNote, startViolations } from "./lib/hooks.mjs";
import { installDevServer } from "./lib/main-host.mjs";
import { cliOnly, commandFiles } from "./lib/named.mjs";
import { baseDir } from "./lib/paths.mjs";
import { prepare } from "./lib/prepare.mjs";
import { checkTypes } from "./lib/typecheck.mjs";

/** @param {string} root - From tinker(); why: the app's paths, address, and tsconfig. */
function glueConfig(root) {
  const address = { host: process.env.HOST ?? "127.0.0.1", port: Number(process.env.PORT ?? 4318) };
  return {
    resolve: { alias: aliases(root) },
    define: { "import.meta.env.TINKER_APP_ROOT": JSON.stringify(root) },
    server: address,
    preview: address,
    tsconfig: join(root, ".tinker/tsconfig.json"),
    test: { server: { deps: { inline: ["@tinker/start"] } } },
  };
}

/**
 * A build checks in two steps. When the config resolves, before TanStack's route generator
 * runs: doctor's build-start lines, so a stop comes before the generator could rewrite a route
 * file in src/. At build start, once the generator wrote the route tree: the app's own tsc.
 * Then this build's boundary record starts empty; Start's onViolation fills it.
 * A CLI-only app passes no record: it runs no Start, so it gets only its named check and tsc.
 * @param {string} root - From tinker(); why: the app being built.
 * @param {{ found?: Map<string, object> }} [record] - From tinker(); why: shared with onViolation.
 */
function verify(root, record) {
  let checked = false;
  let typed = false;
  return {
    name: "tinker:verify",
    apply: "build",
    configResolved: {
      order: "pre",
      handler(config) {
        if (checked) return;
        checked = true;
        const { errors, warnings } = buildChecks(root, { cli: !record });
        for (const line of warnings) config.logger.warn(line);
        if (errors.length > 0) throw new Error(errors.join("\n"));
      },
    },
    buildStart() {
      if (typed) return;
      typed = true;
      const types = checkTypes(root);
      if (types.length > 0) this.error(types.join("\n"));
      if (record) record.found = startViolations(root);
    },
  };
}

/**
 * Restart dev when a picked file comes or goes (see restartNote).
 * @param {string} root - From tinker(); why: watch that app's picked files.
 */
function restartOn(root) {
  return {
    name: "tinker:restart",
    apply: "serve",
    configureServer(server) {
      installDevServer(root, server);
      const restart = (verb) => (path) => {
        const note = restartNote(root, path, verb);
        if (!note) return;
        server.config.logger.info(note, { timestamp: true });
        void server.restart();
      };
      server.watcher.on("add", restart("added"));
      server.watcher.on("unlink", restart("removed"));
      server.watcher.on("change", restart("changed"));
    },
  };
}

/**
 * Tailwind's Vite plugin, when the app installs it: a registry item cannot edit
 * vite.config.ts, so the base adds the plugin, and the app owns the version.
 * @param {string} root - From tinker(); why: resolve @tailwindcss/vite from the app.
 */
async function tailwind(root) {
  let path;
  try {
    path = createRequire(join(root, "package.json")).resolve("@tailwindcss/vite");
  } catch {
    return null;
  }
  return (await import(pathToFileURL(path).href)).default();
}

/**
 * A CLI-only app's plugins: the glue, which builds cmds/cli.ts the way its vite.cli.config.ts
 * names, so `vp build` is its build; and the checks, before anything is built.
 * @param {string} root - From tinker(); why: the app being built.
 */
function cliPlugins(root) {
  const cli = commandFiles(root).find((entry) => entry.role === "cli");
  const build = { ssr: cli.file, outDir: cli.outDir };
  return [
    { name: "tinker:glue", enforce: "pre", config: () => ({ ...glueConfig(root), build }) },
    verify(root),
  ];
}

/**
 * The glue: one call in the app's vite.config.ts joins the app to the base (ADR 0106).
 * An app that names `cliEntry` and no web entry is CLI-only: it gets the aliases, the generated
 * tsconfig, its build checks, and no web plugins, routes, React, or TanStack Start.
 * @param {{ root?: string, serverEntry: string, routerEntry: string, startEntry: string, compileHints?: boolean, prerender?: object, pages?: object[], spa?: object, sitemap?: object }} [options] - From vite.config.ts; why: the app folder (default cwd), the app-owned native command entries, and Start's static output options.
 */
export function tinker(options = {}) {
  const passed = passThrough(options);
  const root = resolve(options.root ?? process.cwd());
  if (cliOnly(root)) {
    prepare(root);
    return cliPlugins(root);
  }

  if (!existsSync(join(root, "src/routes"))) throw new Error(`tinker: ${routeSay.missing}`);
  prepare(root);

  const own = startOptions(root);
  const serverEntry = own.server.entry;
  const glue = {
    name: "tinker:glue",
    enforce: "pre",
    config(_config, { command }) {
      own.server.entry =
        command === "serve"
          ? relative(join(root, "src"), join(baseDir, "lib/dev-server.mjs"))
          : serverEntry;
      return glueConfig(root);
    },
  };
  const record = {};
  /** Returns nothing: Start drops a violation whose hook returns false. */
  const onViolation = (info) => {
    if (record.found) recordViolation(root, record.found, info);
  };

  // A web app loads TanStack Start and React here, so a CLI-only app never needs them.
  const start = import("@tanstack/react-start/plugin/vite").then(({ tanstackStart }) =>
    tanstackStart({
      ...own,
      ...passed,
      importProtection: { ...own.importProtection, onViolation },
    }),
  );

  if (process.env.VITEST) return [glue, start];

  return [
    glue,
    verify(root, record),
    restartOn(root),
    start,
    import("@vitejs/plugin-react").then(({ default: react }) => react()),
    tailwind(root),
    clientOutput(options.compileHints ?? true),
    serverOutput(root),
  ];
}
