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
import { writeResponse } from "../lib/host-response.mjs";
import { createMainHost } from "../lib/main-host.mjs";
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

const hostKey = Symbol("tinker.host");
const abortKey = Symbol("tinker.abort");

/**
 * Reading `signal` on hono's light Request builds a full undici Request. This one getter, shared by
 * every request so they keep one shape, keeps hono's abort rule without that copy.
 */
const lazySignal = {
  configurable: true,
  get() {
    this[abortKey] ??= watchClose(this[hostKey]);
    return this[abortKey].signal;
  },
};

/**
 * @param {Request} request - From hono; why: an own `signal` shadows the prototype getter.
 * @param {{ incoming: import("node:http").IncomingMessage, outgoing: import("node:http").ServerResponse }} env - From hono; why: the close that aborts.
 */
function withLazySignal(request, env) {
  request[hostKey] = env;
  return Object.defineProperty(request, "signal", lazySignal);
}

/**
 * Hono's rule: an incoming error, or a close before the response finished, aborts.
 * @param {{ incoming: import("node:http").IncomingMessage, outgoing: import("node:http").ServerResponse }} env - From hono; why: the request's two streams.
 */
function watchClose({ incoming, outgoing }) {
  const controller = new AbortController();
  const abort = () => {
    if (incoming.errored) controller.abort(incoming.errored.toString());
    else if (!outgoing.writableFinished) controller.abort("Client connection prematurely closed.");
  };

  if (outgoing.destroyed) abort();
  else outgoing.once("close", abort);
  return controller;
}

/**
 * The Node host starts the built entry before listening; the command owns config and shutdown.
 * @param {string} root - From tinker serve; why: the built app to serve.
 */
async function serve(root) {
  if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));
  /** React and other deps pick their production build from this at load, as `next start` does. */
  process.env.NODE_ENV ??= "production";
  const built = await import(pathToFileURL(join(root, "dist/server/server.js")).href);
  let server;

  let stopped;
  const host = createMainHost(built.default, {
    env: process.env,
    args: rest,
    cwd: root,
    stdout: process.stdout,
    stderr: process.stderr,
    validate: (app) => {
      if (typeof app.fetch !== "function") throw new TypeError("server main must return fetch");
    },
    onStart: async (app, signal) => {
      const asset = await createAssets(root);
      if (signal.aborted) return;

      /** Lend the Node response as srvx and h3 do; the app ends its request before the reply ends. */
      const render = async (request, { incoming, outgoing }) => {
        request.runtime = { name: "node", node: { req: incoming, res: outgoing } };
        const response = await compressResponse(request, await app.fetch(request));
        return writeResponse(request, response, outgoing);
      };
      server = listen(
        {
          overrideGlobalObjects: false,
          hostname: process.env.HOST ?? "127.0.0.1",
          port: Number(process.env.PORT ?? 4318),
          fetch: (request, env) => asset(request) ?? render(withLazySignal(request, env), env),
        },
        (info) =>
          console.log(`tinker serve: http://${process.env.HOST ?? "127.0.0.1"}:${info.port}`),
      );
      signal.addEventListener(
        "abort",
        () => {
          stopped = new Promise((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        },
        { once: true },
      );
    },
    onStop: async () => {
      if (server && !stopped) {
        stopped = new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
      await stopped;
    },
  });
  const hangup = () => host.stop(129, new DOMException("SIGHUP", "AbortError"));
  const interrupt = () => host.stop(130, new DOMException("SIGINT", "AbortError"));
  const terminate = () => host.stop(143, new DOMException("SIGTERM", "AbortError"));
  process.on("SIGHUP", hangup);
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    return await host.closed;
  } finally {
    process.off("SIGHUP", hangup);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
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
  process.exitCode = 64;
} else process.exitCode = await commands[command]();
