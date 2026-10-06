import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { say as routeSay } from "./lib/checks/routes.mjs";
import { loadEnv } from "./lib/env.mjs";
import { aliases, passThrough, startOptions } from "./lib/glue.mjs";
import { buildChecks } from "./lib/doctor.mjs";
import { partsOn } from "./lib/parts.mjs";
import { recordViolation, restartNote, startViolations } from "./lib/hooks.mjs";
import { checkTypes } from "./lib/typecheck.mjs";
import { prepare } from "./lib/prepare.mjs";

/** @param {string} root - From tinker(); why: the app's paths, address, and tsconfig. */
function glueConfig(root) {
  const address = { host: process.env.HOST ?? "127.0.0.1", port: Number(process.env.PORT ?? 4318) };
  return {
    resolve: { alias: aliases(root) },
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
 * @param {string} root - From tinker(); why: the app being built.
 * @param {{ found?: Map<string, object> }} record - From tinker(); why: shared with onViolation.
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
        const { errors, warnings } = buildChecks(root);
        for (const line of warnings) config.logger.warn(line);
        if (errors.length > 0) throw new Error(errors.join("\n"));
      },
    },
    buildStart() {
      if (typed) return;
      typed = true;
      const types = checkTypes(root);
      if (types.length > 0) this.error(types.join("\n"));
      record.found = startViolations(root);
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
      const restart = (verb) => (path) => {
        const note = restartNote(root, path, verb);
        if (!note) return;
        server.config.logger.info(note, { timestamp: true });
        void server.restart();
      };
      server.watcher.on("add", restart("added"));
      server.watcher.on("unlink", restart("removed"));
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
 * The glue: one call in the app's vite.config.ts joins the app to the base (ADR 0106).
 * @param {{ root?: string, telemetry?: boolean, auth?: boolean, prerender?: object, pages?: object[], spa?: object, sitemap?: object }} [options] - From vite.config.ts; why: the app folder (default cwd), the base parts to turn on or off, and Start's static output options.
 */
export function tinker(options = {}) {
  const passed = passThrough(options);
  const on = partsOn(options);
  const root = resolve(options.root ?? process.cwd());
  loadEnv(root);
  if (!existsSync(join(root, "src/routes"))) throw new Error(`tinker: ${routeSay.missing}`);
  prepare(root, on);
  const glue = { name: "tinker:glue", config: () => glueConfig(root) };
  const own = startOptions(root, on);
  const record = {};
  /** Returns nothing: Start drops a violation whose hook returns false. */
  const onViolation = (info) => {
    if (record.found) recordViolation(root, record.found, info);
  };
  const start = tanstackStart({
    ...own,
    ...passed,
    importProtection: { ...own.importProtection, onViolation },
  });
  if (process.env.VITEST) return [glue, start];
  return [glue, verify(root, record), restartOn(root), start, react(), tailwind(root)];
}
