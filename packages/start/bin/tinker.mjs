#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { serve as listen } from "@hono/node-server";
import { generatorBlocked, staleTree } from "../lib/checks/generated.mjs";
import { doctor } from "../lib/doctor.mjs";
import { loadEnv } from "../lib/env.mjs";
import { prepare, prepareExitCode } from "../lib/prepare.mjs";
import { createAssets } from "../lib/serve.mjs";
import { compressResponse } from "../lib/compression.mjs";
import { upgrade } from "../lib/upgrade.mjs";

/**
 * Write `.tinker/routeTree.gen.ts` with no dev server and no build: resolving the app's own
 * Vite config runs Start's route generator once, so a fresh clone type-checks.
 * @param {string} root - From tinker prepare; why: load that app's vite.config.ts with its own Vite.
 */
async function writeRouteTree(root) {
  const require = createRequire(join(root, "package.json"));
  const vite = await import(pathToFileURL(require.resolve("vite")).href);
  await vite.resolveConfig({ root, logLevel: "silent" }, "serve");
  return "routeTree.gen.ts";
}

/**
 * The Node host for a built app: `.env`, then built files, then the base's server entry (ADR 0106).
 * @param {string} root - From tinker serve; why: the built app to serve.
 */
async function serve(root) {
  loadEnv(root);
  const built = await import(pathToFileURL(join(root, "dist/server/server.js")).href);
  const asset = await createAssets(root);
  const render = async (request) => compressResponse(request, await built.default.fetch(request));
  const server = listen({
    overrideGlobalObjects: false,
    hostname: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 4318),
    fetch: (request) => asset(request) ?? render(request),
  });
  console.log(
    `tinker serve: http://${process.env.HOST ?? "127.0.0.1"}:${process.env.PORT ?? 4318}`,
  );
  const stopped = Promise.withResolvers();
  process.once("SIGINT", () => stopped.resolve());
  process.once("SIGTERM", () => stopped.resolve());
  await stopped.promise;
  await Promise.all([
    built.close(),
    new Promise((done, reject) => server.close((error) => (error ? reject(error) : done()))),
  ]);
  return 0;
}

const [command, ...rest] = process.argv.slice(2);
const root = process.cwd();
const flag = (name) => rest[rest.indexOf(name) + 1];

const commands = {
  prepare: async () => {
    const files = prepare(root);
    const blocked = generatorBlocked(root);
    if (blocked.length === 0) files.push(await writeRouteTree(root));
    const problems = blocked.length > 0 ? blocked : staleTree(root);
    console.log(
      problems.length > 0
        ? problems.join("\n")
        : `tinker prepare: wrote .tinker/${files.join(", .tinker/")}`,
    );
    return prepareExitCode(problems, process.env.npm_lifecycle_event);
  },
  doctor: () => {
    const { lines, code } = doctor(root, rest.includes("--fix"));
    console.log(lines.join("\n"));
    return code;
  },
  upgrade: () =>
    upgrade(root, rest[0], {
      from: rest.includes("--from") ? flag("--from") : undefined,
      force: rest.includes("--force"),
    }),
  serve: () => serve(root),
};

if (!existsSync(join(root, "package.json")) || !(command in commands)) {
  console.log("usage: tinker prepare | doctor [--fix] | upgrade <version> [--from <dir>] | serve");
  process.exit(2);
}

process.exitCode = await commands[command]();
