#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { serve as listen } from "@hono/node-server";

import { generatorBlocked, staleTree } from "../lib/checks/generated.mjs";
import { serverProblems } from "../lib/checks/named.mjs";
import { compressResponse } from "../lib/compression.mjs";
import { doctor } from "../lib/doctor.mjs";
import { prepare, prepareExitCode } from "../lib/prepare.mjs";
import { createAssets } from "../lib/serve.mjs";

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
 * The Node host starts the built entry before listening; the command owns config and shutdown.
 * @param {string} root - From tinker serve; why: the built app to serve.
 */
async function serve(root) {
  const stop = new AbortController();
  const abort = () => stop.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  const stopped = new Promise((done) =>
    stop.signal.addEventListener("abort", done, { once: true }),
  );

  // Pending startup promises own no Node handle; keep the host alive to receive signals.
  const running = setInterval(() => {}, 2 ** 30);
  try {
    if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));
    const built = await import(pathToFileURL(join(root, "dist/server/server.js")).href);
    const app = await built
      .default({
        env: process.env,
        signal: stop.signal,
        stdout: process.stdout,
        stderr: process.stderr,
      })
      .catch((error) => {
        if (!stop.signal.aborted) console.error(error);
      });
    if (!app) return stop.signal.aborted ? 0 : 1;

    try {
      const asset = await createAssets(root);
      if (stop.signal.aborted) {
        await app.closed;
        return 0;
      }
      const render = async (request) => compressResponse(request, await app.fetch(request));
      const server = listen(
        {
          overrideGlobalObjects: false,
          hostname: process.env.HOST ?? "127.0.0.1",
          port: Number(process.env.PORT ?? 4318),
          fetch: (request) => asset(request) ?? render(request),
        },
        (info) =>
          console.log(`tinker serve: http://${process.env.HOST ?? "127.0.0.1"}:${info.port}`),
      );

      await stopped;
      await new Promise((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
      await app.closed;
      return 0;
    } catch (error) {
      stop.abort();
      await app.closed.catch(() => {});
      console.error(error);
      return 1;
    }
  } finally {
    clearInterval(running);
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

const [command, ...rest] = process.argv.slice(2);
const root = process.cwd();

const commands = {
  prepare: async () => {
    const missing = serverProblems(root);
    if (missing.length > 0) {
      console.log(missing.join("\n"));
      return 1;
    }

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
  serve: () => serve(root),
};

if (!existsSync(join(root, "package.json")) || !(command in commands)) {
  console.log("usage: tinker prepare | doctor [--fix] | serve");
  process.exit(2);
}

process.exitCode = await commands[command]();
